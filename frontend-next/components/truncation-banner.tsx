'use client'

import { AlertTriangle } from 'lucide-react'

/**
 * Banner shown when the backend returned `truncated: true` for a query —
 * meaning the 500-row cap was hit and more data exists beyond what's
 * displayed.
 *
 * Worded as an actionable prompt (not an error) so real users know what
 * to do: narrow the date range to see older traces. A bare "data
 * truncated" message reads like a system fault; this phrasing tells the
 * user the dashboard is working correctly and they have control.
 *
 * Audit finding #4 follow-up: the backend has returned `truncated` since
 * commit 2475287, but it was dropped on the floor by lib/swarm-api.ts
 * (which did `data?.traces ?? []` and discarded the flag). This banner
 * is the missing client half of that fix.
 */
export function TruncationBanner({ range = 'this range' }: { range?: string }) {
  return (
    <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span>
        Showing the most recent 500 traces of {range} — older traces exist but
        aren&apos;t included. Narrow the date filter to see older activity.
      </span>
    </div>
  )
}
