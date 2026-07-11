/**
 * Build Supabase query strings for the `traces` table, with optional
 * server-side time-range filtering.
 *
 * Extracted from app/api/{agents,overview,traces}/route.ts so the query
 * construction is unit-testable (scripts/test-trace-query.mjs) and so the
 * three routes can't drift on the filter syntax.
 *
 * This is the fix for audit finding #4: the Agents route used to apply the
 * `since` (date-range) filter CLIENT-SIDE in JS, AFTER fetching the 500
 * most-recent traces from Supabase. So if a user had >500 traces total,
 * anything older than the 500th-most-recent was never fetched from the DB
 * at all — regardless of which time range they selected. No error, no
 * "partial data" indicator — it just looked like those agents didn't
 * exist. Pushing `since` into the Supabase query as `&timestamp=gte.<iso>`
 * makes the DB apply the filter BEFORE the limit, so the 500-row cap
 * applies to the user's selected window, not to all-time.
 */

export interface TracesQueryOpts {
  /** Inclusive lower bound, as epoch milliseconds. Optional. */
  since?: number | null
  /**
   * Exclusive upper bound, as an ISO 8601 timestamp string. Optional.
   * Used for cursor pagination — pass the oldest timestamp seen in the
   * previous page to fetch the page before it. Not currently used by the
   * dashboard UI, but supported so future pagination can be added without
   * another route change.
   */
  before?: string | null
  /** Max rows to return. Defaults to 500 (the prior hard-coded value). */
  limit?: number
}

export const DEFAULT_TRACE_LIMIT = 500

/**
 * Build a Supabase REST query string for the traces table, scoped to a
 * specific user, ordered most-recent-first, with optional time-range
 * filters pushed into the DB query (not applied post-fetch).
 *
 * Returns just the path+query (e.g. `traces?user_id=eq.X&...`) — the
 * caller passes it to supaUserRequest.
 */
export function buildTracesQuery(
  userId: string,
  opts: TracesQueryOpts = {},
): string {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_TRACE_LIMIT
  let path =
    `traces?user_id=eq.${encodeURIComponent(userId)}` +
    `&order=timestamp.desc&limit=${limit}`

  if (Number.isFinite(opts.since as number)) {
    // Convert epoch ms → ISO 8601 for Supabase's timestamp filter.
    // The `gte.` operator is inclusive on the lower bound.
    const iso = new Date(opts.since as number).toISOString()
    path += `&timestamp=gte.${encodeURIComponent(iso)}`
  }

  if (opts.before) {
    // `lt.` (less-than) is exclusive on the upper bound — the cursor row
    // itself is not repeated. Combined with `order=timestamp.desc`, this
    // gives a stable backward-paginating cursor.
    path += `&timestamp=lt.${encodeURIComponent(opts.before)}`
  }

  return path
}

/**
 * Parse the `since` query-string param from a Request URL.
 *
 * Accepts epoch milliseconds (the format lib/api.ts sends). Returns null
 * for missing/invalid input so callers can fall back to "no filter".
 */
export function parseSinceParam(url: string): number | null {
  const sinceParam = new URL(url).searchParams.get('since')
  // Treat both missing and empty-string as "no filter" — distinct from
  // explicit `?since=0`, which IS a valid (if unusual) epoch-ms filter.
  if (sinceParam == null || sinceParam === '') return null
  const ms = Number(sinceParam)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Parse the `before` query-string param (ISO 8601 timestamp) for cursor
 * pagination. Returns null for missing/invalid input.
 */
export function parseBeforeParam(url: string): string | null {
  const beforeParam = new URL(url).searchParams.get('before')
  if (!beforeParam) return null
  // Validate that it parses as a date — don't pass garbage to Supabase.
  const ms = Date.parse(beforeParam)
  return Number.isFinite(ms) ? beforeParam : null
}

/**
 * Returns true when the response hit the row cap, signalling that more
 * rows may exist beyond this page. Routes use this to set `truncated: true`
 * in their response so the client can show a "more data exists" indicator
 * instead of silently omitting older traces.
 *
 * Note: this is a heuristic — `rows.length === limit` is a strong signal
 * but not proof (the user might have exactly `limit` rows total). The
 * client should treat it as "probably more" rather than "definitely more".
 */
export function isTruncated(rows: unknown[], limit: number = DEFAULT_TRACE_LIMIT): boolean {
  return Array.isArray(rows) && rows.length >= limit
}
