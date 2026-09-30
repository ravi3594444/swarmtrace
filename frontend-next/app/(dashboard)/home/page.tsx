'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { FirstRunEmptyState, isFirstRun, markHasTraces } from '@/components/first-run-empty-state'
import { StatusBanner } from '@/components/home/StatusBanner'
import { SimpleStatCards } from '@/components/home/SimpleStatCards'
import { AttentionList } from '@/components/home/AttentionList'
import { PlainActivityFeed } from '@/components/home/PlainActivityFeed'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { filterTracesByRange } from '@/lib/trace-utils'
import { AlertTriangle } from 'lucide-react'

/**
 * Plain-English "how is it going today?" page. Numbers come from the same
 * trace data as the developer pages. Copy here avoids jargon: say
 * "request/run/response time/issue", not trace/span/latency.
 */
export default function HomePage() {
  const { traces, truncated, loading, isLive } = useSwarmTraces()

  // Fixed window: since local midnight. No picker on this page.
  const todayTraces = useMemo(() => filterTracesByRange(traces, 'today'), [traces])

  // First-run detection, same as Overview.
  const [firstRunChecked, setFirstRunChecked] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration localStorage read; runs once.
    setFirstRunChecked(true)
  }, [])
  useEffect(() => {
    if (traces.length > 0) markHasTraces()
  }, [traces.length])
  const showFirstRun = firstRunChecked && !loading && traces.length === 0 && isFirstRun()

  if (loading) {
    return <DashboardSkeleton title="Home" description="How your AI is doing today" />
  }

  if (showFirstRun) {
    return (
      <>
        <PageHeader title="Home" description="How your AI is doing today" />
        <FirstRunEmptyState />
      </>
    )
  }

  const issueCount = todayTraces.filter((t) => t.error).length

  return (
    <>
      <PageHeader
        title="Home"
        description="How your AI is doing today"
        liveStatus={isLive ? 'live' : 'paused'}
      />

      {/* Plain-copy truncation notice (the shared TruncationBanner talks
          about "traces" and a date filter this page doesn't have). */}
      {truncated && (
        <div className="mx-4 sm:mx-6 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">
            Showing recent activity only — totals for today may be undercounted on very busy days.
          </span>
        </div>
      )}

      <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
        <StatusBanner hasActivity={todayTraces.length > 0} issueCount={issueCount} />

        <SimpleStatCards traces={todayTraces} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
          <AttentionList traces={todayTraces} />
          <PlainActivityFeed traces={todayTraces} />
        </div>

        {/* Drill-down for users who outgrow the simple view. */}
        <p className="text-xs text-muted-foreground">
          Want the technical view?{' '}
          <Link href="/overview" className="font-medium text-primary hover:underline underline-offset-2">Overview</Link>
          {' · '}
          <Link href="/traces" className="font-medium text-primary hover:underline underline-offset-2">Traces</Link>
          {' · '}
          <Link href="/metrics" className="font-medium text-primary hover:underline underline-offset-2">Metrics</Link>
        </p>
      </div>
    </>
  )
}
