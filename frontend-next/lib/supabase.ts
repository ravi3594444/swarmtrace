import { auth } from '@clerk/nextjs/server'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
// NEXT_PUBLIC_SUPABASE_ANON_KEY is read lazily inside supaUserRequest() — see
// note there. SUPABASE_URL / SUPABASE_SERVICE_KEY are read here at module
// load (matches the existing pattern) but the anon key needs to be
// re-readable for the fallback branch to pick up env var changes.
const SUPA_TIMEOUT_MS      = 5_000

// ── RLS enforcement mode ────────────────────────────────────────────────────
//
// supaUserRequest enforces Postgres RLS by passing the per-user Clerk session
// JWT as the Bearer token. When that JWT is unavailable (Clerk not hydrated,
// integration not configured) or rejected by Supabase (401/403 — typically
// the Clerk↔Supabase native integration isn't enabled in the dashboard), the
// OLD behavior was to silently fall back to the service-role key and log a
// console.warn. That was dangerous: RLS was bypassed and the only signal was
// a log line an operator might never see.
//
// The NEW behavior is fail-closed in production:
//
//   - In production (NODE_ENV === 'production') without a valid Clerk JWT,
//     supaUserRequest throws RlsEnforcementError, which the route catches
//     and converts to a 401. The user sees "Unauthorized" (better UX than
//     a silent cross-tenant leak) and the operator sees a structured error
//     in the Vercel logs.
//
//   - In development (NODE_ENV !== 'production'), the fallback is preserved
//     so local dev works without the Clerk↔Supabase integration configured.
//     A console.warn is still logged.
//
//   - SUPABASE_RLS_FALLBACK=1 re-enables the silent fallback in ANY
//     environment. This is an explicit operator escape hatch for emergency
//     debugging or staged rollouts — a deliberate action, not a silent
//     default. When used, a console.warn is logged on every fallback so
//     it's visible in logs.
//
// See lib/health-check.ts for startup-time validation of these env vars.
const isProduction = process.env.NODE_ENV === 'production'
const fallbackEnabled = process.env.SUPABASE_RLS_FALLBACK === '1' || !isProduction

// Thrown when RLS cannot be enforced and the fallback is disabled. Routes
// catch this and convert to a 401. Exported so tests can assert on it and
// routes can instanceof-check it.
export class RlsEnforcementError extends Error {
  constructor(reason: string) {
    super(`RLS enforcement failed: ${reason}. Refusing to fall back to service-role key in production — set SUPABASE_RLS_FALLBACK=1 to override (NOT recommended for production).`)
    this.name = 'RlsEnforcementError'
  }
}

// ── RLS decision logic (pure, exported for testing) ─────────────────────────
//
// Extracted from supaUserRequest so the decision tree is unit-testable
// without mocking @clerk/nextjs/server. supaUserRequest calls this, then
// either builds the happy-path headers, throws RlsEnforcementError, or
// builds the fallback headers.
//
// Returns one of:
//   - { mode: 'rls', anonKey }           — use Clerk JWT + anon key (RLS enforced)
//   - { mode: 'fallback', reason }       — use service-role key (RLS bypassed)
//   - { mode: 'fail-closed', reason }    — throw RlsEnforcementError
export type RlsDecision =
  | { mode: 'rls'; anonKey: string }
  | { mode: 'fallback'; reason: string }
  | { mode: 'fail-closed'; reason: string }

export function decideRlsMode(params: {
  token: string | null
  tokenFailureReason?: string | null
  anonKey: string | undefined
  fallbackEnabled: boolean
}): RlsDecision {
  const { token, anonKey, fallbackEnabled } = params
  const tokenFailureReason = params.tokenFailureReason ?? null

  if (token && anonKey) {
    return { mode: 'rls', anonKey }
  }
  // No token or no anon key — can't enforce RLS.
  const reason = !token
    ? (tokenFailureReason ?? 'Clerk token unavailable')
    : 'NEXT_PUBLIC_SUPABASE_ANON_KEY missing'

  if (!fallbackEnabled) {
    return { mode: 'fail-closed', reason }
  }
  return { mode: 'fallback', reason }
}

// ── supaRequest — for write/admin paths only (ingest, RPC, mutations) ─────────
//
// Uses the service-role key which BYPASSES RLS. Only call this for:
//   - upsert_trace / increment_daily_metrics RPC calls in /api/ingest
//   - agent_events inserts in /api/events
//   - /api/mcp (authenticates via API key, no Clerk user context)
//
// NEVER use this for user-facing reads or writes — use supaUserRequest()
// instead so Postgres RLS is enforced as a second line of defense on top of
// the manual user_id filter in the query URL.
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

// ── supaUserRequest — for user-facing reads AND writes (enforces RLS) ───────
//
// Passes the per-user Clerk session JWT as the Authorization Bearer token,
// with the anon key in apikey. PostgREST validates the JWT against Clerk's
// public JWKS endpoint (one-time dashboard setup, see
// supabase/migrations/0005_production_fixes.sql), resolves auth.jwt() ->> 'sub'
// to the Clerk user ID, and the RLS policies on every table enforce user-
// scoped access at the DB level — independent of the manual user_id filter
// the caller also builds into `path`. This is the real second line of
// defense: even if a future route forgets the URL filter, RLS still blocks
// cross-tenant access.
//
// Fail-closed: in production, if RLS cannot be enforced (no JWT, or Supabase
// rejects the JWT with 401/403), this throws RlsEnforcementError instead of
// silently falling back to the service-role key. The route converts that to
// a 401. In development, the fallback is preserved for local-dev ergonomics.
// Set SUPABASE_RLS_FALLBACK=1 to re-enable the fallback in any environment
// (emergency escape hatch — logs a warn on every use).
export async function supaUserRequest(
  path: string,
  userId: string,
  options: RequestInit = {},
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are missing on this server instance.')
  }

  // auth() is request-scoped via AsyncLocalStorage and safe to call from any
  // function downstream of a route handler / server action.
  let token: string | null = null
  let tokenFailureReason: string | null = null
  try {
    const { getToken } = await auth()
    token = await getToken().catch(() => null)
    if (!token) tokenFailureReason = 'Clerk getToken() returned null'
  } catch (e) {
    token = null
    tokenFailureReason = `auth() threw: ${e instanceof Error ? e.message : String(e)}`
  }

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  const headers: Record<string, string> = {
    'Content-Type':          'application/json',
    Prefer:                  'return=representation',
    'x-swarmtrace-user-id':  userId,   // audit-log header
    ...(options.headers as Record<string, string> | undefined),
  }

  // ── Decide how to authenticate this request ──────────────────────────────
  const decision = decideRlsMode({
    token,
    tokenFailureReason,
    anonKey,
    fallbackEnabled,
  })

  if (decision.mode === 'fail-closed') {
    throw new RlsEnforcementError(decision.reason)
  }

  if (decision.mode === 'rls') {
    // Happy path: real per-user JWT + anon key → RLS enforced.
    headers.apikey        = decision.anonKey
    headers.Authorization = `Bearer ${token}`
  } else {
    // Fallback: service-role key, RLS NOT enforced. Log loudly so it's
    // visible in logs — every fallback is a potential security signal.
    console.warn(
      `[supaUserRequest] RLS fallback: ${decision.reason}. ` +
      'RLS is NOT enforced on this request; relying on the manual user_id ' +
      'filter only. (NODE_ENV=' + process.env.NODE_ENV +
      ', SUPABASE_RLS_FALLBACK=' + (process.env.SUPABASE_RLS_FALLBACK || 'unset') + ') ' +
      'Verify the Clerk↔Supabase integration is enabled in your Supabase ' +
      'dashboard (see supabase/migrations/0005_production_fixes.sql).'
    )
    headers.apikey        = SUPABASE_SERVICE_KEY
    headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const usedJwt = decision.mode === 'rls'

  let response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
  })

  // ── 401/403 on the JWT path: Clerk↔Supabase integration not configured ────
  //
  // If we sent a real Clerk JWT (happy path) and Supabase rejected it with
  // 401/403, the most likely cause is that the Clerk↔Supabase native
  // integration isn't configured yet in the Supabase dashboard.
  //
  // In production with fallback disabled: FAIL CLOSED — throw
  // RlsEnforcementError. Retrying with the service-role key would bypass
  // RLS silently, which is exactly what this fix prevents.
  //
  // In development (or with SUPABASE_RLS_FALLBACK=1): fall back to the
  // service-role key and retry once, so local dev keeps working.
  if (!response.ok && (response.status === 401 || response.status === 403) && usedJwt) {
    // Consume the error response body so the connection can be reused.
    await response.text().catch(() => {})

    if (!fallbackEnabled) {
      throw new RlsEnforcementError(
        `Supabase rejected the Clerk JWT with ${response.status}. ` +
        'Verify the Clerk↔Supabase integration is enabled in your Supabase dashboard.'
      )
    }

    console.warn(
      `[supaUserRequest] Supabase rejected the Clerk JWT with ${response.status} — ` +
      'falling back to service-role key and retrying. RLS is NOT enforced on ' +
      'this request. Verify the Clerk↔Supabase integration is enabled in ' +
      'your Supabase dashboard (see supabase/migrations/0005_production_fixes.sql).'
    )
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
