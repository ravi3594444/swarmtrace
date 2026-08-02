'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from 'recharts'
import { chartTooltip } from '@/lib/chart-tooltip'

export type ChartPoint = { date: string; cost: number; input: number; output: number; traces: number }

/**
 * The three daily-metrics charts on the Metrics page, extracted from
 * app/metrics/page.tsx so they can be next/dynamic-imported — recharts is
 * ~492 KB across 3 chunks (bundle audit) and previously loaded synchronously
 * with the page's initial JS even before any chart data existed to show.
 * All three are always rendered together on this page, so one dynamic
 * chunk covering all three (rather than three separate ones) is simplest.
 */

export function TokenUsageChart({ chart }: { chart: ChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={42} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip {...chartTooltip} />
        <Legend wrapperStyle={{ fontSize: 11, color: 'var(--muted-foreground)' }} />
        <Bar dataKey="input" name="Input tokens" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={32} />
        <Bar dataKey="output" name="Output tokens" fill="var(--chart-3)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function CostChart({ chart }: { chart: ChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={46} tickFormatter={(v) => `$${v.toFixed(2)}`} />
        <Tooltip {...chartTooltip} formatter={(v) => [`$${Number(v ?? 0).toFixed(3)}`, 'Cost']} />
        <Line type="monotone" dataKey="cost" stroke="var(--primary)" strokeWidth={2} dot={{ fill: 'var(--primary)', strokeWidth: 0, r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function TraceVolumeChart({ chart }: { chart: ChartPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
        <Tooltip {...chartTooltip} />
        <Bar dataKey="traces" name="Traces" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  )
}
