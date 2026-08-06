'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { DashboardLayout } from '@/components/dashboard-layout'
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
 * Home — the plain-English "how is it going?" page for non-technical
 * users. It answers three questions at a glance: Is everything OK? What
 * did it do today? What needs my attention? Every number and group is
 * derived from the same trace data (and the same math) as the developer
 * pages, so nothing here contradicts Overview / Traces / Failures — the
 * difference is purely in how it's phrased and how little is shown.
 *
 * Deliberately absent (kept on the advanced pages): date pickers, charts,
 * raw JSON, token counts, trace IDs, span trees. Copy rules for this page
 * and its components: no "trace/span/token/latency/p95/regression" — say
 * "request/run/usage/response time/issue" instead.
 */
export default function HomePage() {
  const { traces, truncated, loading, isLive } = useSwarmTraces()

  // Fixed window: today (local midnight). No picker — this page answers
  // "how is TODAY going"; wider windows live on the advanced pages.
  const todayTraces = useMemo(() => filterTracesByRange(traces, 'today'), [traces])

  // First-run detection — same pattern as Overview: show the setup guide
  // only to a brand-new user (never had traces per localStorage), not to
  // an existing user who simply has a quiet day.
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
      <DashboardLayout>
        <PageHeader title="Home" description="How your AI is doing today" />
        <FirstRunEmptyState />
      </DashboardLayout>
    )
  }

  const issueCount = todayTraces.filter((t) => t.error).length

  return (
    <DashboardLayout>
      <PageHeader
        title="Home"
        description="How your AI is doing today"
        liveStatus={isLive ? 'live' : 'paused'}
      />

      {/* Plain-copy truncation notice (the shared TruncationBanner talks
          about "traces" and a date filter this page doesn't have). */}
      {truncated && (
        <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">
            Showing recent activity only — totals for today may be undercounted on very busy days.
          </span>
        </div>
      )}

      <div className="p-6 space-y-6">
        <StatusBanner hasActivity={todayTraces.length > 0} issueCount={issueCount} />

        <SimpleStatCards traces={todayTraces} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
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
    </DashboardLayout>
  )
}
