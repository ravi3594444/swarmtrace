/**
 * Builds Supabase query strings for the traces table, shared by the agents,
 * overview and traces routes.
 *
 * `since` is pushed into the query (timestamp=gte.) so the DB filters before
 * the row limit applies.
 */

export interface TracesQueryOpts {
  /** Inclusive lower bound, as epoch milliseconds. Optional. */
  since?: number | null
  /** Exclusive upper bound (ISO 8601), for cursor pagination. */
  before?: string | null
  /** Max rows to return. Defaults to 500. */
  limit?: number
}

export const DEFAULT_TRACE_LIMIT = 500

/**
 * Build the traces REST query for a user, newest first, with the time-range
 * filters applied in the DB. Returns path+query for supaUserRequest.
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
    // epoch ms to ISO; gte. is inclusive
    const iso = new Date(opts.since as number).toISOString()
    path += `&timestamp=gte.${encodeURIComponent(iso)}`
  }

  if (opts.before) {
    // lt. is exclusive, so the cursor row isn't repeated
    path += `&timestamp=lt.${encodeURIComponent(opts.before)}`
  }

  return path
}

/** Parse the `since` param (epoch ms, as lib/api.ts sends it); null if missing/invalid. */
export function parseSinceParam(url: string): number | null {
  const sinceParam = new URL(url).searchParams.get('since')
  // missing and '' mean no filter; an explicit ?since=0 is still valid
  if (sinceParam == null || sinceParam === '') return null
  const ms = Number(sinceParam)
  return Number.isFinite(ms) ? ms : null
}

/** Parse the `before` param (ISO 8601) used for cursor pagination; null if missing/invalid. */
export function parseBeforeParam(url: string): string | null {
  const beforeParam = new URL(url).searchParams.get('before')
  if (!beforeParam) return null
  // don't pass garbage to Supabase
  const ms = Date.parse(beforeParam)
  return Number.isFinite(ms) ? beforeParam : null
}

/**
 * True when the response hit the row cap, i.e. there are probably more rows.
 * It's a heuristic: exactly `limit` rows could also be the full set.
 */
export function isTruncated(rows: unknown[], limit: number = DEFAULT_TRACE_LIMIT): boolean {
  return Array.isArray(rows) && rows.length >= limit
}
