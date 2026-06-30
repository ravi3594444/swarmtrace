'use client'

import { useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { SwarmLoadingScreen } from '@/components/swarm/LoadingScreen'
import type { Trace } from '@/lib/trace-types'
import { AlertTriangle, Bug, TrendingDown } from 'lucide-react'

function formatTime(iso: string) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export default function FailuresPage() {
  const { traces, loading } = useSwarmTraces(10000)
  const [selected, setSelected] = useState<Trace | null>(null)

  if (loading) return (
    <DashboardLayout>
      <SwarmLoadingScreen message="Scanning for failures…" />
    </DashboardLayout>
  )

  const failed = traces.filter((t) => t.error)
  const errorRate = traces.length ? ((failed.length / traces.length) * 100).toFixed(1) : '0.0'
  const errorTypes = failed.reduce<Record<string, number>>((acc, t) => {
    const type = t.error?.split(':')[0] ?? 'Unknown'
    acc[type] = (acc[type] ?? 0) + 1
    return acc
  }, {})

  return (
    <DashboardLayout>
      <PageHeader
        title="Failures"
        description="All errored spans with root-cause detail"
        badge={`${failed.length} ERRORS`}
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Total Errors', value: String(failed.length), sub: `of ${traces.length} spans`, icon: AlertTriangle },
            { label: 'Error Rate', value: `${errorRate}%`, sub: 'of all executed spans', icon: TrendingDown },
            { label: 'Error Types', value: String(Object.keys(errorTypes).length), sub: 'distinct error classes', icon: Bug },
          ].map(({ label, value, sub, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Icon className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-bold">{label}</span>
              </div>
              <div className="text-4xl font-bold text-foreground leading-none tracking-tight">{value}</div>
              <div className="text-xs text-muted-foreground mt-2.5">{sub}</div>
            </div>
          ))}
        </div>

        {Object.keys(errorTypes).length > 0 && (
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Error Breakdown</h3>
            </div>
            <div className="divide-y divide-border/40">
              {Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <div key={type} className="flex items-center gap-4 px-4 py-3">
                  <span className="flex-1 text-xs text-foreground font-medium truncate">{type}</span>
                  <div className="w-40 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-red-300 rounded-full" style={{ width: `${(count / failed.length) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right text-xs font-semibold text-foreground">{count}×</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {failed.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-20 text-center shadow-sm">
            <div className="w-12 h-12 rounded-full border border-emerald-200 bg-emerald-50 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">✓</span>
            </div>
            <div className="text-sm font-semibold text-foreground">No failures detected</div>
            <div className="text-xs text-muted-foreground mt-1">All spans completed successfully</div>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/20 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 text-left">ID</th>
                  <th className="px-4 py-3 text-left">Function</th>
                  <th className="px-4 py-3 text-left">Error</th>
                  <th className="px-4 py-3 text-right">Latency</th>
                  <th className="px-4 py-3 text-left">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {failed.map((t) => (
                  <tr key={t.id} onClick={() => setSelected(t)} className="cursor-pointer hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{t.id.slice(0, 10)}</td>
                    <td className="px-4 py-3 text-sm font-medium text-foreground">{t.function}</td>
                    <td className="px-4 py-3 text-xs text-red-600 max-w-xs truncate">{t.error}</td>
                    <td className="px-4 py-3 text-xs font-mono tabular-nums text-right">{(t.latency_sec ?? 0).toFixed(2)}s</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTime(t.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DetailDrawer trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
