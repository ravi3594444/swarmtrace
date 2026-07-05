import { auth } from '@clerk/nextjs/server'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
// NEXT_PUBLIC_SUPABASE_ANON_KEY is read lazily inside supaUserRequest() — see
// note there. SUPABASE_URL / SUPABASE_SERVICE_KEY are read here at module
// load (matches the existing pattern) but the anon key needs to be
// re-readable for the fallback branch to pick up env var changes.
const SUPA_TIMEOUT_MS      = 5_000

// ── supaRequest — for write/admin paths only (ingest, RPC, mutations) ─────────
//
// Uses the service-role key which BYPASSES RLS. Only call this for:
//   - upsert_trace / increment_daily_metrics RPC calls in /api/ingest
//   - agent_events inserts in /api/events
//   - api_keys CRUD in /api/settings/api-keys
//
// Never use this for user-facing reads — use supaUserRequest() instead so
// Postgres RLS is enforced as a second line of defense on top of the manual
// user_id filter in the query URL.
export async function supaRequest(path: string, options: RequestInit = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are missing on this server instance.')
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const headers = {
    apikey:          SUPABASE_SERVICE_KEY,
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation',
    ...(options.headers as Record<string, string> | undefined),
  }

  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Supabase ${response.status}: ${text || response.statusText}`)
  }

  const text = await response.text()
  return text ? JSON.parse(text) : null
}

// ── supaUserRequest — for user-facing reads (enforces RLS) ───────────────────
//
// Passes the per-user Clerk session JWT as the Authorization Bearer token,
// with the anon key in apikey. PostgREST validates the JWT against Clerk's
// public JWKS endpoint (one-time dashboard setup, see
// supabase/migrations/0005_production_fixes.sql), resolves auth.jwt() ->> 'sub'
// to the Clerk user ID, and the RLS policies on every table enforce user-
// scoped access at the DB level — independent of the manual user_id filter
// the caller also builds into `path`. This is the real second line of
// defense: even if a future route forgets the URL filter, RLS still blocks
// cross-tenant reads.
//
// Mirrors the client-side pattern in contexts/RealtimeContext.tsx: getToken()
// with no template returns the standard Clerk session token, which Supabase
// accepts directly once the native Clerk↔Supabase integration is enabled.
//
// Fallback: if Clerk can't produce a token (e.g. the integration isn't
// configured yet, or auth isn't fully hydrated for the request), falls back
// to the service-role key so the app keeps working. The manual user_id
// filter in the URL still provides isolation in that case, but RLS is NOT
// the second line of defense. A console.warn leaves an audit trail in the
// Vercel logs so a silently-unconfigured integration is visible.
export async function supaUserRequest(
  path: string,
  userId: string,
  options: RequestInit = {},
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are missing on this server instance.')
  }

  // auth() is request-scoped via AsyncLocalStorage and safe to call from any
  // function downstream of a route handler / server action. The route already
  // called it once for userId; calling it again here for getToken() returns
  // the same cached auth context (no extra work).
  //
  // Wrap the whole JWT-acquisition in a try/catch so ANY failure (auth()
  // throwing, getToken() rejecting, Clerk context not hydrated, edge-runtime
  // quirks) falls through to the service-role fallback instead of 500ing the
  // route. The route's own try/catch would otherwise convert this into a 500
  // — defeating the whole "graceful fallback" design. A warn is logged in the
  // fallback branch below so the failure is still visible.
  let token: string | null = null
  try {
    const { getToken } = await auth()
    token = await getToken().catch(() => null)
  } catch {
    token = null
  }

  // Read the anon key lazily so env var changes (e.g. operator fixes a
  // missing NEXT_PUBLIC_SUPABASE_ANON_KEY after deploy) are picked up without
  // a full redeploy. SUPABASE_URL / SUPABASE_SERVICE_KEY above are read at
  // module load (matches the existing pattern); the anon key is the only one
  // the lazy fallback branch needs to re-evaluate.
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  const headers: Record<string, string> = {
    'Content-Type':          'application/json',
    Prefer:                  'return=representation',
    'x-swarmtrace-user-id':  userId,   // audit-log header
    ...(options.headers as Record<string, string> | undefined),
  }

  if (token && anonKey) {
    // Happy path: real per-user JWT + anon key → RLS enforced.
    headers.apikey        = anonKey
    headers.Authorization = `Bearer ${token}`
  } else {
    // Fallback path: keep the app working, but RLS is NOT enforced.
    if (!token) {
      console.warn(
        '[supaUserRequest] No Clerk token — falling back to service-role key. ' +
        'RLS is NOT enforced on this request; relying on the manual user_id ' +
        'filter only. Verify the Clerk↔Supabase integration is enabled in ' +
        'your Supabase dashboard (see supabase/migrations/0005_production_fixes.sql).'
      )
    } else if (!anonKey) {
      console.warn(
        '[supaUserRequest] NEXT_PUBLIC_SUPABASE_ANON_KEY missing — falling back ' +
        'to service-role key. RLS is NOT enforced on this request.'
      )
    }
    headers.apikey        = SUPABASE_SERVICE_KEY
    headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const usedJwt = !!(token && anonKey)   // true if the happy-path headers were set

  let response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  })

  // ── 401/403 retry: misconfigured-integration safety net ──────────────────
  //
  // If we sent a real Clerk JWT (happy path) and Supabase rejected it with
  // 401/403, the most likely cause is that the Clerk↔Supabase native
  // integration isn't configured yet in the Supabase dashboard (a manual
  // step — see supabase/migrations/0005_production_fixes.sql). The JWT is
  // valid Clerk-side, but Supabase doesn't recognize the issuer.
  //
  // Without this retry, every dashboard page would 500 until the operator
  // completes the dashboard setup — a brutal first-run experience. Instead,
  // fall back to the service-role key (same as if getToken() had returned
  // null) and retry the request once. The manual user_id filter in the URL
  // still provides isolation; RLS is just not enforced for this request.
  // A warn leaves an audit trail in the Vercel logs.
  //
  // We only retry on 401/403 (auth errors), NOT on 4xx data errors (404,
  // 422, etc.) or 5xx server errors — those are real problems that falling
  // back won't fix.
  if (!response.ok && (response.status === 401 || response.status === 403) && usedJwt) {
    console.warn(
      `[supaUserRequest] Supabase rejected the Clerk JWT with ${response.status} — ` +
      'falling back to service-role key and retrying. RLS is NOT enforced on ' +
      'this request. Verify the Clerk↔Supabase integration is enabled in ' +
      'your Supabase dashboard (see supabase/migrations/0005_production_fixes.sql).'
    )
    // Consume the error response body so the connection can be reused.
    await response.text().catch(() => {})
    headers.apikey        = SUPABASE_SERVICE_KEY
    headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`
    response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Supabase ${response.status}: ${text || response.statusText}`)
  }

  const text = await response.text()
  return text ? JSON.parse(text) : null
}
