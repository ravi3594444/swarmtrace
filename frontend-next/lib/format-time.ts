/**
 * Time formatting helpers. Trace times in tables and lists are shown in UTC
 * so the same trace reads the same on every page and for every viewer.
 * formatTraceTime is for tables, formatFullTime for detail views, and
 * formatRelativeTime (lib/api.ts) for "2 minutes ago".
 */

/** Format an ISO timestamp as HH:MM:SS in UTC; returns the original string if it can't be parsed. */
export function formatTraceTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * Format an ISO timestamp as a full localized date+time string (local time)
 * for Threads and detail drawers.
 */
export function formatFullTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
