/**
 * Time formatting helpers for the SwarmTrace dashboard.
 *
 * Why UTC: trace timestamps are stored as ISO 8601 UTC strings and the
 * canonical trace views (TraceTable, Failures) render them in UTC so the
 * same trace shows the same time regardless of the viewer's timezone.
 * This was previously a bug — /traces showed UTC while /failures showed
 * local time, making the same trace look like it happened at different
 * times. The fix was to use UTC everywhere trace times appear in a table
 * or list. See the comment in app/failures/page.tsx (pre-extraction).
 *
 * Use `formatTraceTime` for table/list views (HH:MM:SS UTC).
 * Use `formatFullTime` for detail views where the full date matters.
 * Use `formatRelativeTime` (from lib/api.ts) for "2 minutes ago" style.
 */

/**
 * Format an ISO timestamp as HH:MM:SS in UTC.
 * Used by TraceTable, Failures, and any table that shows trace times.
 * Returns the original string if parsing fails.
 */
export function formatTraceTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * Format an ISO timestamp as a full localized date+time string.
 * Used by Threads (where the full date helps distinguish old conversations)
 * and detail drawers. This one intentionally uses local time + toLocaleString
 * because it's for human-readable context, not for cross-page consistency.
 */
export function formatFullTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
