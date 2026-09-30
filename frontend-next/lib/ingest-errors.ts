/**
 * Turns raw PostgREST/Postgres/network failures into stable error codes with
 * a remediation hint. Typical case: migrations weren't applied, so
 * upsert_trace_for_key fails with PGRST202 on every ingest POST. Raw database
 * text goes to server logs only, never the response.
 */

export type IngestErrorCode =
  /** The RPC, a table or a column is missing, i.e. migrations not (fully) applied. */
  | 'SCHEMA_NOT_MIGRATED'
  /** Supabase/PostgREST answered 5xx, or the network failed. */
  | 'DB_UNAVAILABLE'
  /** The Supabase request timed out. */
  | 'DB_TIMEOUT'
  /** Anything else (constraint violation, unexpected Postgres error). */
  | 'DB_ERROR'

export interface ClassifiedError {
  code: IngestErrorCode
  /** Static remediation text, safe to expose: never includes database messages. */
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
 * Classify a failure thrown by the Supabase fetch helpers: missing RPC or
 * table (PGRST202, 42P01, 42703), SQL errors, 5xx, AbortSignal timeouts and
 * undici network errors. Matching is string-based and conservative, so when
 * unsure it returns DB_ERROR rather than blame the schema.
 */
export function classifySupabaseError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err)
  const name = err instanceof Error ? err.name : ''

  // timeouts first (TimeoutError, or AbortError on older Node)
  if (name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out/i.test(msg)) {
    return { code: 'DB_TIMEOUT', hint: TIMEOUT_HINT }
  }

  // Schema drift. PGRST202 is a missing function; missing tables/columns come
  // through as Postgres 42P01 / 42703 or the plain-English equivalents in the
  // PostgREST error body.
  if (
    /PGRST20[0-9]/.test(msg) ||
    /\b(42P01|42703)\b/.test(msg) ||
    /Could not find the .{1,120} in the schema cache/i.test(msg) ||
    /(relation|table|column|function) [^\s]{1,80} does not exist/i.test(msg)
  ) {
    return { code: 'SCHEMA_NOT_MIGRATED', hint: MIGRATION_HINT }
  }

  // Supabase-side 5xx, from the "Supabase <status>:" / "Supabase RPC <fn> <status>:"
  // wrappers and the events/mcp variants
  if (/Supabase[^\n]{0,64}?\b5\d\d\b/.test(msg)) {
    return { code: 'DB_UNAVAILABLE', hint: UNAVAILABLE_HINT }
  }

  // network-level failures (DNS, TLS, refused/reset)
  if (
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)
  ) {
    return { code: 'DB_UNAVAILABLE', hint: UNAVAILABLE_HINT }
  }

  return { code: 'DB_ERROR', hint: GENERIC_HINT }
}

/**
 * Build the public response body for a classified failure. The error text is
 * fixed per code; raw database messages are logged server-side only.
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
