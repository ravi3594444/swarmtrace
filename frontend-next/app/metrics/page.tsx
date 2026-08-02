'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { fetchMetrics } from '@/lib/api'
import dynamic from 'next/dynamic'
import { Download, TrendingDown, CheckCircle2, BarChart3 } from 'lucide-react'
import { useIntegrations } from '@/contexts/IntegrationsContext'
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'

// recharts is ~492 KB across 3 chunks (bundle audit) — split out of the
// page's initial JS and only fetched once a chart actually needs to render.
// ssr: false because recharts' ResponsiveContainer measures the DOM.
const chartLoading = <div className="h-full w-full animate-pulse rounded-lg bg-muted/30" />
const TokenUsageChart = dynamic(() => import('@/components/swarm/MetricsCharts').then((m) => m.TokenUsageChart), { ssr: false, loading: () => chartLoading })
const CostChart = dynamic(() => import('@/components/swarm/MetricsCharts').then((m) => m.CostChart), { ssr: false, loading: () => chartLoading })
const TraceVolumeChart = dynamic(() => import('@/components/swarm/MetricsCharts').then((m) => m.TraceVolumeChart), { ssr: false, loading: () => chartLoading })

type ChartPoint = { date: string; cost: number; input: number; output: number; traces: number }
type MetricsTotals = { cost: number; tokens_in: number; tokens_out: number; traces: number }
type MetricsData = {
  today: MetricsTotals; last_7_days: MetricsTotals; this_month: MetricsTotals; all_time: MetricsTotals
  chart: ChartPoint[]
}

function MetricCard({ label, value, unit, trend }: { label: string; value: string; unit?: string; trend: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{label}</div>
      <div className="text-4xl font-bold tabular-nums text-foreground leading-none tracking-tight">
        {value}{unit && <span className="ml-1.5 text-base font-medium text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2.5 text-xs text-muted-foreground">{trend}</div>
    </div>
  )
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr)
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleDateString(undefined, { weekday: 'short' })
}

function RegressionMonitorPanel({ data }: { data: MetricsData | null }) {
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <TrendingDown className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Regression Monitor</h3>
        <span className="ml-1.5 flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />ACTIVE
        </span>
      </div>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: 'Traces analysed', value: data?.all_time?.traces?.toLocaleString() ?? '0' },
            { label: 'Regressions detected', value: '0' },
            { label: 'Status', value: 'Active' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-muted/30 rounded-xl p-3 border border-border">
              <p className="text-xs text-muted-foreground mb-1">{label}</p>
              <p className="text-xl font-bold text-foreground">{value}</p>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-green-500/5 border border-green-500/20">
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            No output regressions detected. To activate LLM-based comparison, install{' '}
            <code className="font-mono bg-muted px-1 rounded">swarmtrace[regression]</code> and run{' '}
            <code className="font-mono bg-muted px-1 rounded">swarmtrace.compare()</code> in your evaluation scripts.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function MetricsPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<MetricsData | null>(null)
  const { isEnabled } = useIntegrations()

  useEffect(() => {
    let mounted = true
    fetchMetrics().then((d) => {
      if (!mounted) return
      setData(d)
      setLoading(false)
    })
    return () => { mounted = false }
  }, [])

  const exportCSV = () => {
    const chart = data?.chart ?? []
    // Guard against empty data — without this, the user could download a
    // CSV containing only the header row (no data rows). The button is also
    // disabled when there's no data, but this is a belt-and-suspenders check.
    if (chart.length === 0) return
    const rows = chart.map((r) => `${r.date},${r.input},${r.output},${r.cost},${r.traces}`).join('\n')
    const blob = new Blob(['date,input_tokens,output_tokens,cost_usd,traces\n' + rows], { type: 'text/csv' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'swarmtrace-metrics.csv' })
    a.click(); URL.revokeObjectURL(a.href)
  }

  // DashboardSkeleton already renders DashboardLayout itself — don't wrap
  // it again or the sidebar renders twice while loading.
  if (loading) return (
    <DashboardSkeleton title="Metrics" description="Latency, token, and cost trends over time" />
  )

  const chart = (data?.chart ?? []).map((d) => ({ ...d, day: dayLabel(d.date) }))
  const allTime = data?.all_time ?? { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 }
  const totalTokens = allTime.tokens_in + allTime.tokens_out
  const last7 = data?.last_7_days
  const hasChartData = chart.length > 0

  return (
    <DashboardLayout>
      <PageHeader
        title="Metrics"
        description="Token usage, cost, and throughput analytics"
        actions={
          <button
            onClick={exportCSV}
            disabled={!hasChartData}
            title={hasChartData ? 'Export daily metrics as CSV' : 'No metrics to export yet'}
            className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:bg-card"
          >
            <Download className="w-3.5 h-3.5" />Export CSV
          </button>
        }
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard label="Total Tokens" value={totalTokens.toLocaleString()} trend="all time" />
          <MetricCard label="Total Cost" value={`$${allTime.cost.toFixed(3)}`} trend="all time" />
          <MetricCard label="Traces" value={String(allTime.traces)} trend="all time" />
          <MetricCard label="Last 7 Days" value={`$${(last7?.cost ?? 0).toFixed(3)}`} trend={`${last7?.traces ?? 0} traces`} />
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">Daily Token Usage</h3>
            <span className="text-[11px] text-muted-foreground">{chart.length} day{chart.length === 1 ? '' : 's'}</span>
          </div>
          <div className="p-4 h-52">
            {chart.length === 0 ? (
              <Empty className="h-full p-0 md:p-0 border-0 gap-2">
                <EmptyMedia variant="icon">
                  <BarChart3 className="w-5 h-5" />
                </EmptyMedia>
                <EmptyTitle>No metrics yet</EmptyTitle>
                <EmptyDescription>Token usage will appear here once traces start flowing in.</EmptyDescription>
              </Empty>
            ) : (
              <TokenUsageChart chart={chart} />
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Daily Cost (USD)</h3>
            </div>
            <div className="p-4 h-48">
              {chart.length === 0 ? (
                <Empty className="h-full p-0 md:p-0 border-0 gap-2">
                  <EmptyMedia variant="icon">
                    <BarChart3 className="w-5 h-5" />
                  </EmptyMedia>
                  <EmptyTitle>No metrics yet</EmptyTitle>
                  <EmptyDescription>Daily cost will appear here once traces start flowing in.</EmptyDescription>
                </Empty>
              ) : (
                <CostChart chart={chart} />
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Trace Volume</h3>
            </div>
            <div className="p-4 h-48">
              {chart.length === 0 ? (
                <Empty className="h-full p-0 md:p-0 border-0 gap-2">
                  <EmptyMedia variant="icon">
                    <BarChart3 className="w-5 h-5" />
                  </EmptyMedia>
                  <EmptyTitle>No metrics yet</EmptyTitle>
                  <EmptyDescription>Trace volume will appear here once traces start flowing in.</EmptyDescription>
                </Empty>
              ) : (
                <TraceVolumeChart chart={chart} />
              )}
            </div>
          </div>
        </div>

        {/* Integration Panels */}
        {isEnabled('regression-detector') && (
          <RegressionMonitorPanel data={data} />
        )}
      </div>
    </DashboardLayout>
  )
}
