import type { Trace } from './trace-types'

// Time-range filtering. The dashboard defaults to "All Time"; the header
// dropdown switches between Today / This Week / This Month. Filtering
// happens once at the page level so every widget gets the same filtered
// array. Ranges use the browser's local time, and boundaries are inclusive.

export type TimeRangeKey = 'today' | 'week' | 'month' | 'all'

export type TimeRange = {
  key: TimeRangeKey
  label: string
  /** Short label for compact UI (e.g. the dropdown trigger). */
  short: string
}

export const TIME_RANGES: readonly TimeRange[] = [
  { key: 'today', label: 'Today',        short: 'Today'      },
  { key: 'week',  label: 'This Week',    short: 'This Week'  },
  { key: 'month', label: 'This Month',   short: 'This Month' },
  { key: 'all',   label: 'All Time',     short: 'All Time'   },
] as const

/** Inclusive lower bound (ms since epoch) for the range in local time, or `null` for "All Time". */
export function rangeStartMs(key: TimeRangeKey, now: Date = new Date()): number | null {
  if (key === 'all') return null
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (key === 'today') return start.getTime()
  if (key === 'week') {
    // Week starts on Monday (ISO). Move back to the most recent Monday.
    const day = (start.getDay() + 6) % 7 // 0 = Monday … 6 = Sunday
    start.setDate(start.getDate() - day)
    return start.getTime()
  }
  if (key === 'month') {
    // First day of the current month at 00:00 local.
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  }
  return null
}

/** Filter traces to the selected range. Returns the same array for "All Time" so useMemo deps stay stable. */
export function filterTracesByRange(traces: Trace[], key: TimeRangeKey, now: Date = new Date()): Trace[] {
  if (key === 'all') return traces
  const start = rangeStartMs(key, now)
  if (start == null) return traces
  return traces.filter((t) => {
    const ms = new Date(t.timestamp).getTime()
    // invalid/missing timestamps count as out of range (NaN would slip through)
    return Number.isFinite(ms) && ms >= start
  })
}

export function buildCallChain(trace: Trace, all: Trace[]): Trace[] {
  const byId = new Map(all.map((t) => [t.id, t]))
  const chain: Trace[] = []
  let cur: Trace | undefined = trace
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur)
    seen.add(cur.id)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return chain
}

export function getSiblings(trace: Trace, all: Trace[]): Trace[] {
  if (!trace.parent_id) return all.filter((t) => !t.parent_id && t.id !== trace.id)
  return all.filter((t) => t.parent_id === trace.parent_id && t.id !== trace.id)
}
