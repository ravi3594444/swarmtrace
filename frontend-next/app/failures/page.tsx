'use client'

import { useMemo, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import type { Trace } from '@/lib/trace-types'
import { clusterErrors } from '@/lib/error-clustering'
import { formatTraceTime as formatTime } from '@/lib/format-time'
import { filterTracesByRange } from '@/lib/trace-utils'
import { AlertTriangle, TrendingDown, ChevronRight, Layers } from 'lucide-react'

export default function FailuresPage() {
  const { traces, loading } = useSwarmTraces(10000)
  const { range, setRange } = useTimeRange()
  const [selected, setSelected] = useState<Trace | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Filter traces to the selected time range before computing failure stats.
  // Matches Overview's behavior — picking "Today" on the dashboard should
  // carry over to Failures so old errors don't dilute the "what's broken
  // RIGHT NOW" signal. Range defaults to "today" via useTimeRange.
  const filteredTraces = useMemo(
    () => filterTracesByRange(traces, range),
    [traces, range],
  )

  if (loading) return (
    <DashboardLayout>
      <DashboardSkeleton title="Failures" description="Clustered errors from your agents" />
    </DashboardLayout>
  )

  const failed = filteredTraces.filter((t) => t.error)
  const errorRate = filteredTraces.length ? ((failed.length / filteredTraces.length) * 100).toFixed(1) : '0.0'
  const clusters = clusterErrors(filteredTraces)
  const maxCount = clusters[0]?.count ?? 1

  return (
    <DashboardLayout>
      <PageHeader
        title="Failures"
        description="Errors auto-grouped by root cause"
        badge={`${failed.length} ERRORS`}
        actions={
          <TimeRangeDropdown value={range} onChange={setRange} />
        }
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: 'Total Errors', value: String(failed.length), sub: `of ${filteredTraces.length} spans`, icon: AlertTriangle },
            { label: 'Error Rate', value: `${errorRate}%`, sub: 'of all executed spans', icon: TrendingDown },
            { label: 'Error Clusters', value: String(clusters.length), sub: 'distinct root causes', icon: Layers },
          ].map(({ label, value, sub, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200">
              <div className="flex items-center gap-2 mb-3">
                <Icon className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-bold">{label}</span>
              </div>
              <div className="text-4xl font-bold text-foreground leading-none tracking-tight">{value}</div>
              <div className="text-xs text-muted-foreground mt-2.5">{sub}</div>
            </div>
          ))}
        </div>

        {clusters.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-20 text-center shadow-sm">
            <div className="w-12 h-12 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">✓</span>
            </div>
            <div className="text-sm font-semibold text-foreground">No failures detected</div>
            <div className="text-xs text-muted-foreground mt-1">All spans completed successfully</div>
          </div>
        ) : (
          <div className="space-y-3">
            {clusters.map((c) => {
              const isOpen = expanded[c.signature] ?? false
              return (
                <div key={c.signature} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [c.signature]: !isOpen }))}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/30 transition-colors"
                  >
                    <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                    <span className="shrink-0 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/60 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-400 font-mono">{c.type}</span>
                    <span className="flex-1 text-xs text-foreground/90 truncate font-mono">{c.sample}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground hidden sm:inline">{c.functions.slice(0, 2).join(', ')}{c.functions.length > 2 ? ` +${c.functions.length - 2}` : ''}</span>
                    <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0 hidden md:block">
                      <div className="h-full bg-red-300 rounded-full" style={{ width: `${(c.count / maxCount) * 100}%` }} />
                    </div>
                    <span className="shrink-0 w-12 text-right text-sm font-bold text-foreground tabular-nums">{c.count}×</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border/60 animate-slide-in-up">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border/60 bg-muted/20 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            <th className="px-4 py-2.5 text-left">ID</th>
                            <th className="px-4 py-2.5 text-left">Function</th>
                            <th className="px-4 py-2.5 text-left">Error</th>
                            <th className="px-4 py-2.5 text-right">Latency</th>
                            <th className="px-4 py-2.5 text-left">Time</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {c.traces.map((t) => (
                            <tr key={t.id} onClick={() => setSelected(t)} className="cursor-pointer hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{t.id.slice(0, 10)}</td>
                              <td className="px-4 py-3 text-sm font-medium text-foreground">{t.function}</td>
                              <td className="px-4 py-3 text-xs text-red-600 dark:text-red-400 max-w-xs truncate">{t.error}</td>
                              <td className="px-4 py-3 text-xs font-mono tabular-nums text-right">{(t.latency_sec ?? 0).toFixed(2)}s</td>
                              <td className="px-4 py-3 text-xs text-muted-foreground">{formatTime(t.timestamp)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <DetailDrawer trace={selected} allTraces={filteredTraces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
