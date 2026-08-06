'use client'

import Link from 'next/link'
import { CheckCircle, AlertTriangle, MoonStar } from 'lucide-react'

/**
 * StatusBanner — the one-line answer to "how is it going?" at the top of
 * the Home page. Written for non-technical users: no error codes, no
 * jargon, just a plain statement plus a single next step when something
 * is wrong.
 *
 * Three states:
 *   - No activity yet today  → neutral, calm "nothing has run yet".
 *   - Activity, zero issues  → emerald all-clear.
 *   - Issues present         → destructive accent + a link to /failures.
 */
export function StatusBanner({
  hasActivity,
  issueCount,
}: {
  /** Whether any requests ran today. */
  hasActivity: boolean
  /** Number of requests/runs that hit an issue today. */
  issueCount: number
}) {
  if (!hasActivity) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-sm p-5 flex items-start gap-4 transition-[background-color,border-color,color] duration-200">
        <div className="w-10 h-10 rounded-lg border border-border bg-muted/60 flex items-center justify-center shrink-0">
          <MoonStar className="w-[18px] h-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">No activity yet today</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Nothing has run so far. Once your AI starts handling requests, this page updates on its own.
          </p>
        </div>
      </div>
    )
  }

  if (issueCount === 0) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-sm p-5 flex items-start gap-4 transition-[background-color,border-color,color] duration-200">
        <div className="w-10 h-10 rounded-lg border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center shrink-0">
          <CheckCircle className="w-[18px] h-[18px] text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Everything is running smoothly</h2>
          <p className="text-sm text-muted-foreground mt-1">
            No issues detected today. You don&apos;t need to do anything.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 shadow-sm p-5 flex items-start gap-4 transition-[background-color,border-color,color] duration-200">
      <div className="w-10 h-10 rounded-lg border border-destructive/30 bg-destructive/10 flex items-center justify-center shrink-0">
        <AlertTriangle className="w-[18px] h-[18px] text-destructive" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold text-foreground">
          {issueCount} {issueCount === 1 ? 'issue needs' : 'issues need'} attention today
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Some requests didn&apos;t complete. Details are listed below — or{' '}
          <Link href="/failures" className="font-medium text-primary underline underline-offset-2 hover:no-underline">
            see what&apos;s wrong →
          </Link>
        </p>
      </div>
    </div>
  )
}
