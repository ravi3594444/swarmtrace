'use client'

import { DashboardLayout } from '@/components/dashboard-layout'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import { NodeNetworkMap } from '@/components/swarm/NodeNetworkMap'
import { TruncationBanner } from '@/components/truncation-banner'
import { useAgentGraph } from '@/lib/use-agent-graph'
import { AlertTriangle, GitBranch, Radio, RefreshCw } from 'lucide-react'

function NetworkStat({ label, value, accent = 'cyan' }: { label: string; value: string; accent?: 'cyan' | 'violet' | 'emerald' | 'amber' }) {
  const color = {
    cyan: 'from-cyan-400/20 to-blue-500/10 text-cyan-100 border-cyan-400/25',
    violet: 'from-violet-400/20 to-fuchsia-500/10 text-violet-100 border-violet-400/25',
    emerald: 'from-emerald-400/20 to-teal-500/10 text-emerald-100 border-emerald-400/25',
    amber: 'from-amber-400/20 to-orange-500/10 text-amber-100 border-amber-400/25',
  }[accent]
  return (
    <div className={`rounded-2xl border bg-gradient-to-br ${color} px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.25)]`}>
      <div className="text-[10px] font-bold uppercase tracking-[0.24em] text-slate-400">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold text-white">{value}</div>
    </div>
  )
}

export default function NetworkPage() {
  const { range, setRange } = useTimeRange()
  const { graph, truncated, loading, isLive, refresh, toggleLive } = useAgentGraph(range, 7000)

  if (loading) {
    return <DashboardSkeleton title="Node Network Map" description="Drawing agent collaboration graph" />
  }

  return (
    <DashboardLayout>
      <div className="min-h-full bg-[#020617] text-white">
        <div className="border-b border-white/10 bg-[#030712]/95 px-6 py-5 shadow-[0_18px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-300">
                <Radio className="h-4 w-4" /> Swarm topology
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
                Node Network Map
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                Individual agent nodes, live collaboration modes, per-agent RAG badges, and force-directed connection lines from real trace context.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeDropdown value={range} onChange={setRange} />
              <button
                onClick={refresh}
                className="flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-semibold text-slate-200 transition hover:bg-white/10"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
              <button
                onClick={toggleLive}
                className={`flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition ${
                  isLive
                    ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20'
                    : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.9)]' : 'bg-slate-500'}`} />
                {isLive ? 'Live' : 'Paused'}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <NetworkStat label="Agents" value={graph.summary.agents.toLocaleString()} accent="cyan" />
            <NetworkStat label="Connections" value={graph.summary.edges.toLocaleString()} accent="violet" />
            <NetworkStat label="Orchestrators" value={graph.summary.orchestrators.toLocaleString()} accent="emerald" />
            <NetworkStat label="RAG agents" value={graph.summary.ragAgents.toLocaleString()} accent="amber" />
            <NetworkStat label="Errors" value={graph.summary.totalErrors.toLocaleString()} accent={graph.summary.totalErrors > 0 ? 'amber' : 'cyan'} />
          </div>
        </div>

        {truncated && (
          <div className="px-6 pt-5">
            <TruncationBanner range="the selected graph range" />
          </div>
        )}

        <div className="p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-slate-400">
            <GitBranch className="h-4 w-4 text-cyan-300" />
            <span><strong className="text-slate-200">Collaboration modes:</strong> orchestrator, sub-agent, peer, and solo are derived from actual parent/child agent spans and shared trace/session context.</span>
            {graph.summary.totalErrors > 0 && (
              <span className="ml-auto flex items-center gap-1.5 text-amber-200">
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
