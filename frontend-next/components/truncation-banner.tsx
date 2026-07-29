'use client'

import { AlertTriangle } from 'lucide-react'

/**
 * Banner shown when the backend returned `truncated: true` for a query —
 * meaning the row cap was hit and more data exists beyond what's displayed.
 *
 * The cap (default 500) is passed in from the API response so the banner
 * never lies if the backend cap changes. An optional `onLoadMore` callback
 * renders a "Load more" button when the backend supports pagination —
 * otherwise the user is told to narrow the date filter (the only way to
 * see older data without pagination support).
 *
 * Audit finding #4 follow-up: the backend has returned `truncated` since
 * commit 2475287, but it was dropped on the floor by lib/swarm-api.ts.
 * This banner is the client half of that fix.
 */
export function TruncationBanner({
  range = 'this range',
  cap = 500,
  onLoadMore,
  loadingMore,
}: {
  range?: string
  /** The backend row cap that was hit. Defaults to 500 (the historical value). */
  cap?: number
  /** If provided, renders a "Load more" button that calls this handler. */
  onLoadMore?: () => void
  /** Disables the Load more button and shows a spinner while a load is in flight. */
  loadingMore?: boolean
}) {
  return (
    <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span className="flex-1">
        Showing the most recent {cap.toLocaleString()} traces of {range} — older traces exist but
        aren&apos;t included.{' '}
        {onLoadMore ? (
          <>
            <button
              onClick={onLoadMore}
              disabled={loadingMore}
              className="font-semibold underline underline-offset-2 hover:no-underline disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
            {' '}or narrow the date filter.
          </>
        ) : (
          <>Narrow the date filter to see older activity.</>
        )}
      </span>
    </div>
  )
}
