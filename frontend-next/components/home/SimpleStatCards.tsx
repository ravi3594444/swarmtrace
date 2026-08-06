'use client'

import { memo } from 'react'
import type { Trace } from '@/lib/trace-types'
import { Activity, CheckCircle, Coins, Clock } from 'lucide-react'

/**
 * SimpleStatCards — the four numbers a non-technical user actually cares
 * about, in plain English with a one-line helper under each. This is the
 * Home-page counterpart to the developer-oriented StatBar on Overview:
 * same underlying math (so the numbers never contradict each other), but
 * sentence-case labels, helper text, and no jargon ("traces" → "requests",
 * "latency" → "response time", tokens hidden entirely).
 *
 * Memoized for the same reason StatBar is: the page polls every 8s and we
 * don't want the slide-in animation replaying on every tick.
 */

/** Top-level ("root") traces — a whole request, not a step inside one.
 *  Same filter as StatBar so the counts match the advanced pages. */
export function rootTraces(traces: Trace[]): Trace[] {
  return traces.filter((t) => !t.parent_id || !traces.some((x) => x.id === t.parent_id))
}

const StatCard = memo(function StatCard({
  label, value, helper, icon: Icon,
}: {
  label: string
  value: string
  helper: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div className="w-9 h-9 rounded-lg border border-border bg-muted/60 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
      <div className="text-3xl font-bold tabular-nums text-foreground leading-none tracking-tight">
        {value}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{helper}</div>
    </div>
  )
})

export function SimpleStatCards({ traces }: { traces: Trace[] }) {
  const roots = rootTraces(traces)
  const errors = traces.filter((t) => t.error).length
  const totalCost = traces.reduce((s, t) => s + t.cost_usd, 0)
  const avgResponse = roots.length > 0
    ? roots.reduce((s, t) => s + t.latency_sec, 0) / roots.length
    : 0
  const successRate = traces.length > 0
    ? ((traces.length - errors) / traces.length) * 100
    : null

  const hasActivity = traces.length > 0

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <div className="animate-slide-in-up" style={{ animationDelay: '0ms' }}>
        <StatCard
          label="Requests today"
          value={String(roots.length)}
          icon={Activity}
          helper={hasActivity ? 'times your AI handled something' : 'nothing has run yet'}
        />
      </div>
      <div className="animate-slide-in-up" style={{ animationDelay: '40ms' }}>
        <StatCard
          label="Success rate"
          value={successRate != null ? `${successRate.toFixed(1)}%` : '—'}
          icon={CheckCircle}
          helper={hasActivity ? 'of requests completed without issues' : 'no requests to measure'}
        />
      </div>
      <div className="animate-slide-in-up" style={{ animationDelay: '80ms' }}>
        <StatCard
          label="Cost today"
          value={`$${totalCost.toFixed(2)}`}
          icon={Coins}
          helper="estimated spend so far"
        />
      </div>
      <div className="animate-slide-in-up" style={{ animationDelay: '120ms' }}>
        <StatCard
          label="Typical response time"
          value={hasActivity ? `~${avgResponse.toFixed(1)}s` : '—'}
          icon={Clock}
          helper={hasActivity ? 'how long a request usually takes' : 'no requests to measure'}
        />
      </div>
    </div>
  )
}
