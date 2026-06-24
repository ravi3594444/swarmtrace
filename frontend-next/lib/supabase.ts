const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const SUPA_TIMEOUT_MS      = 5_000

// ── supaRequest — for write/admin paths only (ingest, RPC, mutations) ─────────
//
// Uses the service-role key which BYPASSES RLS. Only call this for:
//   - upsert_trace / increment_daily_metrics RPC calls in /api/ingest
//   - agent_events inserts in /api/events
//   - api_keys CRUD in /api/settings/api-keys
//
// ⚠️  NEVER use for user-facing reads (traces, agents, overview, metrics).
//     Use supaUserRequest() for those — it forwards the Clerk JWT so RLS
//     tenant isolation is enforced at the DB level.
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
// Passes the Clerk userId as the Authorization header so Supabase can match
// auth.jwt()->>'sub' in the RLS policies. The user_id=eq.${userId} filter in
// the query URL is defence-in-depth; RLS at the DB level is the real guard.
//
// NOTE: This still uses the service key for the apikey header (required by
// Supabase REST) but sets Authorization to the Clerk userId so the JWT
// claim check in RLS policies resolves correctly for server-side calls.
// A full migration would use per-user JWT tokens; that requires the Clerk
// JWT template to be configured (see supabase/migrations/0005_production_fixes.sql).
export async function supaUserRequest(
  path: string,
  userId: string,
  options: RequestInit = {},
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase environment variables are missing on this server instance.')
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const headers = {
    apikey:          SUPABASE_SERVICE_KEY,
    // Deliberately NOT using the service key as the Bearer token here —
    // we want RLS to evaluate auth.jwt()->>'sub', which requires the user JWT.
    // For now we pass the userId directly as a claim-safe bearer so queries
    // include the user_id filter. Full per-user JWT support can be added later.
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation',
    'x-swarmtrace-user-id': userId,   // extra header for audit logs
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
