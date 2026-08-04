/**
 * Ingest error classification — turn raw PostgREST/Postgres/network failures
 * into stable, operator-actionable error codes + remediation hints.
 *
 * WHY THIS EXISTS (root cause of "valid API key, zero traces on dashboard"):
 * /api/ingest writes each trace via the PostgREST RPC `upsert_trace_for_key`
 * (migration 0010). When a deployment's Supabase project has not applied the
 * migrations in supabase/migrations/ — e.g. only 0000 was run (enough for
 * the settings UI to create an API key) but 0010 was not — the RPC call
 * fails with PGRST202 ("function not found in schema cache") on EVERY
 * ingest POST. The route used to map that to a generic
 * `500 {"error":"Internal server error"}`, and the Python SDK's urllib
 * error handling discarded even that body, so the operator saw only
 * "remote ingest failed: HTTP Error 500" with no path forward.
 *
 * Now the route (and the /api/health/db self-check) classify the failure:
 * the response body carries a stable `code` and a static `hint` that names
 * the fix. Raw database error text goes ONLY to server-side logs — never
 * the response — so we don't leak schema internals to anonymous callers.
 */

export type IngestErrorCode =
  /** The RPC, a table, or a column the app expects is missing from the
   * database — i.e. supabase/migrations/ has not been (fully) applied. */
  | 'SCHEMA_NOT_MIGRATED'
  /** Supabase/PostgREST itself answered 5xx, or the network failed. */
  | 'DB_UNAVAILABLE'
  /** The Supabase request exceeded its timeout budget. */
  | 'DB_TIMEOUT'
  /** Anything else (constraint violation, unexpected Postgres error, …). */
  | 'DB_ERROR'

export interface ClassifiedError {
  code: IngestErrorCode
  /** Static, operator-actionable remediation text. Safe to expose publicly:
   * never contains database error messages or schema internals. */
  hint: string
}

export const MIGRATION_HINT =
  'The dashboard database schema is missing or behind. Apply the Supabase ' +
  'migrations in supabase/migrations/ in order — run `npm run db:migrate` in ' +
  'frontend-next (needs SUPABASE_DB_URL) or paste them in the Supabase SQL ' +
  'editor — then verify with GET /api/health/db. See docs/SUPABASE_SETUP.md.'

const UNAVAILABLE_HINT =
  'The dashboard could not reach its database (Supabase returned 5xx or the ' +
  'network failed). Check the Supabase project status, the SUPABASE_URL / ' +
  'SUPABASE_SERVICE_KEY env vars, and retry. GET /api/health/db reports the ' +
  'live status.'

const TIMEOUT_HINT =
  'The database did not answer within the timeout budget. This is usually ' +
  'transient (cold start or project paused) — retry. Supabase free-tier ' +
  'projects pause after inactivity; open the Supabase dashboard to resume.'

const GENERIC_HINT =
  'Unexpected database error while storing the trace. Details are in the ' +
  'server logs (search for the failing route name). GET /api/health/db ' +
  'checks schema state.'

/**
 * Classify a failure thrown by the Supabase fetch helpers.
 *
 * Error shapes seen in practice:
 *  - `Error("Supabase 404: {...PGRST202...}")`   — RPC/table missing
 *  - `Error("Supabase 400: {...42P01/42703/P0001/28000...}")` — SQL errors
 *  - `Error("Supabase 500/502/503: ...")`        — Supabase-side outage
 *  - `Error("Supabase RPC <fn> 404: ...")`       — RPC variant (supaRpc)
 *  - AbortError / TimeoutError                   — AbortSignal.timeout()
 *  - TypeError("fetch failed")                   — Node undici network error
 *
 * Matching is intentionally string-based and conservative: when in doubt we
 * return DB_ERROR (generic hint) rather than mis-claim a schema problem.
 */
export function classifySupabaseError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''

  // Timeouts first — AbortSignal.timeout() rejects with TimeoutError in
  // modern Node (AbortError in older versions). Either way the message is
  // ours, never the database's.
  if (name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out/i.test(msg)) {
    return { code: 'DB_TIMEOUT', hint: TIMEOUT_HINT }
  }

  // Schema drift: the objects the app expects simply aren't there.
  //   PGRST202 — "Could not find the function … in the schema cache"
  //   PGRST204/PGRST205-ish column/table misses surface as Postgres codes
  //   42P01 (undefined_table) / 42703 (undefined_column) embedded in the
  //   PostgREST error body, as do plain-English "relation … does not exist"
  //   / "column … does not exist" / "Could not find the … in the schema cache".
  if (
    /PGRST20[0-9]/.test(msg) ||
    /\b(42P01|42703)\b/.test(msg) ||
    /Could not find the .{1,120} in the schema cache/i.test(msg) ||
    /(relation|table|column|function) [^\s]{1,80} does not exist/i.test(msg)
  ) {
    return { code: 'SCHEMA_NOT_MIGRATED', hint: MIGRATION_HINT }
  }

  // Supabase-side 5xx (from our supa()/supaRpc() "Supabase <status>:" /
  // "Supabase RPC <fn> <status>:" wrappers, and events/mcp's variants
  // "Supabase error <status>:" / "Supabase RPC error:").
  if (/Supabase[^\n]{0,64}?\b5\d\d\b/.test(msg)) {
    return { code: 'DB_UNAVAILABLE', hint: UNAVAILABLE_HINT }
  }

  // Network-level failures (undici) — DNS, TLS, connection refused/reset.
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)
  ) {
    return { code: 'DB_UNAVAILABLE', hint: UNAVAILABLE_HINT }
  }

  return { code: 'DB_ERROR', hint: GENERIC_HINT }
}

/**
 * Build the public response body for a classified ingest-stage failure.
 * `error` text is fixed per-code (safe); the raw database message is never
 * included — route handlers console.error() it for the server logs instead.
 */
export function ingestErrorBody(classified: ClassifiedError): {
  error: string
  code: IngestErrorCode
  hint: string
} {
  const error =
    classified.code === 'SCHEMA_NOT_MIGRATED'
      ? 'Trace storage failed: database schema is not migrated'
      : classified.code === 'DB_UNAVAILABLE'
        ? 'Trace storage failed: database unavailable'
        : classified.code === 'DB_TIMEOUT'
          ? 'Trace storage failed: database timeout'
          : 'Trace storage failed: database error'
  return { error, code: classified.code, hint: classified.hint }
}
