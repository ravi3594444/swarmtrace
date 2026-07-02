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
// ⚠️  Currently used for ALL Supabase access, including user-facing reads
//     (traces, agents, overview, metrics) — every route relies solely on
//     the caller manually adding a `user_id=eq.${userId}` filter to `path`
//     for tenant isolation, since the service-role key bypasses Postgres
//     RLS unconditionally. supaUserRequest() below was intended to add a
//     real RLS-enforced DB-level backstop but does not yet do so (see its
//     own note) and is not currently called anywhere.
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
    // NOTE (correction, not yet fixed): this still authenticates with the
    // service-role key below, same as supaRequest(). The service role
    // bypasses Postgres RLS unconditionally regardless of any other
    // header — so despite the function name and the x-swarmtrace-user-id
    // header, this does NOT currently enforce RLS or provide any DB-level
    // isolation beyond the manual `user_id=eq.` filter the caller builds
    // into `path`. A real fix needs a per-user Clerk JWT (e.g. via the
    // native Clerk↔Supabase JWKS integration already used client-side in
    // contexts/RealtimeContext.tsx) passed as the Bearer token instead of
    // SUPABASE_SERVICE_KEY. This function is also currently uncalled
    // anywhere in the codebase — every route still uses supaRequest().
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
