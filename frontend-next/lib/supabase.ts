import { auth } from '@clerk/nextjs/server'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
// NEXT_PUBLIC_SUPABASE_ANON_KEY is read lazily in supaUserRequest so the
// fallback branch sees env changes.
const SUPA_TIMEOUT_MS      = 5_000

// RLS enforcement: supaUserRequest passes the user's Clerk JWT so Postgres
// RLS applies. If the JWT is missing or rejected (401/403, usually the
// Clerk/Supabase integration isn't enabled), production fails closed with
// RlsEnforcementError, which routes map to a 401. Dev falls back to the
// service-role key with a console.warn. SUPABASE_RLS_FALLBACK=1 forces the
// fallback in any environment. See lib/health-check.ts for env validation.
const isProduction = process.env.NODE_ENV === 'production'
const fallbackEnabled = process.env.SUPABASE_RLS_FALLBACK === '1' || !isProduction

// Thrown when RLS can't be enforced and the fallback is disabled. Routes
// turn it into a 401.
export class RlsEnforcementError extends Error {
  constructor(reason: string) {
    super(`RLS enforcement failed: ${reason}. Refusing to fall back to service-role key in production — set SUPABASE_RLS_FALLBACK=1 to override (NOT recommended for production).`)
    this.name = 'RlsEnforcementError'
  }
}

// RLS decision logic, pure so it can be tested without mocking Clerk.
// Returns { mode: 'rls', anonKey }, { mode: 'fallback', reason } (service
// role, RLS bypassed) or { mode: 'fail-closed', reason } (throw).
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
  // No token or no anon key, so RLS can't be enforced.
  const reason = !token
    ? (tokenFailureReason ?? 'Clerk token unavailable')
    : 'NEXT_PUBLIC_SUPABASE_ANON_KEY missing'

  if (!fallbackEnabled) {
    return { mode: 'fail-closed', reason }
  }
  return { mode: 'fallback', reason }
}

// supaRequest: service-role key, bypasses RLS. Only for the write/admin
// paths: upsert_trace / increment_daily_metrics in /api/ingest, agent_events
// inserts in /api/events, and /api/mcp (API-key auth, no Clerk user).
// User-facing code should use supaUserRequest instead.
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

// supaUserRequest: for user-facing reads and writes, with RLS enforced.
// Sends the Clerk session JWT as the Bearer token and the anon key as apikey;
// PostgREST validates it against Clerk's JWKS (setup in
// supabase/migrations/0005) so RLS scopes rows to the user even if a route
// forgets the user_id filter in `path`.
//
// In production it throws RlsEnforcementError when RLS can't be enforced
// (no JWT, or Supabase returns 401/403). Dev falls back to the service-role
// key; SUPABASE_RLS_FALLBACK=1 enables that anywhere.
export async function supaUserRequest(
  path: string,
  userId: string,
  options: RequestInit = {},
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are missing on this server instance.')
  }

  // auth() is request-scoped and safe to call anywhere under a route handler.
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
    'x-swarmtrace-user-id':  userId,
    ...(options.headers as Record<string, string> | undefined),
  }

  // Decide how to authenticate this request
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
    // Happy path: per-user JWT + anon key, RLS enforced.
    headers.apikey        = decision.anonKey
    headers.Authorization = `Bearer ${token}`
  } else {
    // Fallback: service-role key, RLS not enforced. Warn every time.
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

  // A 401/403 on the JWT path usually means the Clerk/Supabase integration
  // isn't set up. In production (fallback off) throw instead of retrying with
  // the service-role key, which would bypass RLS. In dev, retry once with it.
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
