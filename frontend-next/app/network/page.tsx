'use client'

import { DashboardLayout } from '@/components/dashboard-layout'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import { NodeNetworkMap } from '@/components/swarm/NodeNetworkMap'
import { TruncationBanner } from '@/components/truncation-banner'
import { useAgentGraph } from '@/lib/use-agent-graph'
import { AlertTriangle, GitBranch, Radio, RefreshCw } from 'lucide-react'

/* Charcoal & Ivory Monochrome — tonal emphasis instead of hue.
   'strong' = the headline metric, 'neutral' = everything else,
   'danger' = the one semantic exception, reserved for actual error counts. */
function NetworkStat({ label, value, accent = 'neutral' }: { label: string; value: string; accent?: 'neutral' | 'strong' | 'danger' }) {
  const color = {
    neutral: 'from-white/10 to-white/[0.02] text-on-surface-variant border-border',
    strong: 'from-white/20 to-white/[0.03] text-foreground border-primary/25',
    danger: 'from-destructive/25 to-destructive/5 text-destructive-foreground border-destructive/30',
  }[accent]
  return (
    <div className={`rounded-2xl border bg-gradient-to-br ${color} px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.25)]`}>
      <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold text-foreground">{value}</div>
    </div>
  )
}

export default function NetworkPage() {
  const { range, setRange } = useTimeRange()
  const { graph, truncated, loading, isLive, refresh, toggleLive } = useAgentGraph(range)

  if (loading) {
    return <DashboardSkeleton title="Node Network Map" description="Drawing agent collaboration graph" />
  }

  return (
    <DashboardLayout>
      <div className="min-h-full bg-background text-foreground">
        <div className="border-b border-border bg-surface/95 px-6 py-5 shadow-[0_18px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.28em] text-muted-foreground">
                <Radio className="h-4 w-4" /> Swarm topology
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
                Node Network Map
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Individual agent nodes, live collaboration modes, per-agent RAG badges, and force-directed connection lines from real trace context.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeDropdown value={range} onChange={setRange} />
              <button
                onClick={refresh}
                className="flex h-9 items-center gap-2 rounded-xl border border-border bg-white/5 px-3 text-xs font-semibold text-foreground transition hover:bg-white/10"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
              <button
                onClick={toggleLive}
                className={`flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition ${
                  isLive
                    ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20'
                    : 'border-border bg-white/5 text-foreground hover:bg-white/10'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)]' : 'bg-outline'}`} />
                {isLive ? 'Live' : 'Paused'}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <NetworkStat label="Agents" value={graph.summary.agents.toLocaleString()} accent="strong" />
            <NetworkStat label="Connections" value={graph.summary.edges.toLocaleString()} accent="neutral" />
            <NetworkStat label="Orchestrators" value={graph.summary.orchestrators.toLocaleString()} accent="neutral" />
            <NetworkStat label="RAG agents" value={graph.summary.ragAgents.toLocaleString()} accent="neutral" />
            <NetworkStat label="Errors" value={graph.summary.totalErrors.toLocaleString()} accent={graph.summary.totalErrors > 0 ? 'danger' : 'neutral'} />
          </div>
        </div>

        {truncated && (
          <div className="px-6 pt-5">
            <TruncationBanner range="the selected graph range" />
          </div>
        )}

        <div className="p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-white/[0.03] px-4 py-3 text-xs text-muted-foreground">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span><strong className="text-foreground">Collaboration modes:</strong> orchestrator, sub-agent, peer, and solo are derived from actual parent/child agent spans and shared trace/session context.</span>
            {graph.summary.totalErrors > 0 && (
              <span className="ml-auto flex items-center gap-1.5 text-destructive-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Error nodes are highlighted red.
              </span>
            )}
          </div>
          <NodeNetworkMap
            graph={graph}
            truncated={truncated}
            isLive={isLive}
            onToggleLive={toggleLive}
            onRefresh={refresh}
          />
        </div>
      </div>
    </DashboardLayout>
  )
}
