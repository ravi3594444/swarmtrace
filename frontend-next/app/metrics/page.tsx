'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { SwarmLoadingScreen } from '@/components/swarm/LoadingScreen'
import { fetchMetrics } from '@/lib/api'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from 'recharts'
import { Download } from 'lucide-react'

type ChartPoint = { date: string; cost: number; input: number; output: number; traces: number }
type MetricsTotals = { cost: number; tokens_in: number; tokens_out: number; traces: number }
type MetricsData = {
  today: MetricsTotals; last_7_days: MetricsTotals; this_month: MetricsTotals; all_time: MetricsTotals
  chart: ChartPoint[]
}

const chartTooltip = {
  contentStyle: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.08)' },
  labelStyle: { color: 'var(--foreground)', fontWeight: 600 },
  itemStyle: { color: 'var(--foreground)' },
}

function MetricCard({ label, value, unit, trend }: { label: string; value: string; unit?: string; trend: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
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

export default function MetricsPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<MetricsData | null>(null)

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
    const rows = chart.map((r) => `${r.date},${r.input},${r.output},${r.cost},${r.traces}`).join('\n')
    const blob = new Blob(['date,input_tokens,output_tokens,cost_usd,traces\n' + rows], { type: 'text/csv' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'swarmtrace-metrics.csv' })
    a.click(); URL.revokeObjectURL(a.href)
  }

  if (loading) return (
    <DashboardLayout>
      <SwarmLoadingScreen message="Crunching metrics..." />
    </DashboardLayout>
  )

  const chart = (data?.chart ?? []).map((d) => ({ ...d, day: dayLabel(d.date) }))
  const allTime = data?.all_time ?? { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 }
  const totalTokens = allTime.tokens_in + allTime.tokens_out
  const last7 = data?.last_7_days

  return (
    <DashboardLayout>
      <PageHeader
        title="Metrics"
        description="Token usage, cost, and throughput analytics"
        actions={
          <button onClick={exportCSV} className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shadow-sm">
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
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No metrics yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={42} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip {...chartTooltip} />
                  <Legend wrapperStyle={{ fontSize: 11, color: 'var(--muted-foreground)' }} />
                  <Bar dataKey="input" name="Input" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={32} />
                  <Bar dataKey="output" name="Output" fill="var(--primary)" fillOpacity={0.35} radius={[4, 4, 0, 0]} maxBarSize={32} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Daily Cost (USD)</h3>
            </div>
            <div className="p-4 h-48">
              {chart.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No metrics yet</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={46} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                    <Tooltip {...chartTooltip} formatter={(v) => [`$${Number(v ?? 0).toFixed(3)}`, 'Cost']} />
                    <Line type="monotone" dataKey="cost" stroke="var(--primary)" strokeWidth={2} dot={{ fill: 'var(--primary)', strokeWidth: 0, r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Trace Volume</h3>
            </div>
            <div className="p-4 h-48">
              {chart.length === 0 ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">No metrics yet</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                    <Tooltip {...chartTooltip} />
                    <Bar dataKey="traces" name="Traces" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
