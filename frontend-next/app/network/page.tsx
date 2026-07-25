'use client'

import { DashboardLayout } from '@/components/dashboard-layout'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import { NodeNetworkMap } from '@/components/swarm/NodeNetworkMap'
import { TruncationBanner } from '@/components/truncation-banner'
import { useAgentGraph } from '@/lib/use-agent-graph'
import { AlertTriangle, GitBranch, Radio, RefreshCw } from 'lucide-react'

function NetworkStat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'strong' }) {
  return (
    <div className={`rounded-[1.5rem] border px-4 py-3 ${
      tone === 'strong'
        ? 'border-white/30 bg-white text-black'
        : 'border-[#333333] bg-[#121212] text-[#e5e2e1]'
    }`}>
      <div className={`text-[10px] font-bold uppercase tracking-[0.24em] ${tone === 'strong' ? 'text-black/55' : 'text-[#777777]'}`}>
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl font-bold">{value}</div>
    </div>
  )
}

export default function NetworkPage() {
  const { range, setRange } = useTimeRange()
  const {
    graph,
    truncated,
    loading,
    isLive,
    realtimeConnected,
    realtimeError,
    refresh,
    toggleLive,
  } = useAgentGraph(range)

  if (loading) {
    return <DashboardSkeleton title="Node Network Map" description="Drawing agent collaboration graph" />
  }

  return (
    <DashboardLayout>
      <div className="min-h-full bg-[#0a0a0a] text-[#e5e2e1] font-mono">
        <div className="border-b border-[#333333] bg-[#0e0e0e]/95 px-6 py-5 backdrop-blur-xl">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.28em] text-[#c6c6c7]">
                <Radio className="h-4 w-4" /> Swarm topology
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
                Node Network Map
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#8e9192]">
                Individual agent nodes, collaboration modes, per-agent RAG badges, and force-directed connection lines from real trace context.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeDropdown value={range} onChange={setRange} />
              <button
                onClick={refresh}
                className="flex h-9 items-center gap-2 rounded-full border border-[#333333] bg-[#121212] px-4 text-xs font-semibold text-[#e5e2e1] transition hover:border-white/60 hover:bg-[#1c1b1b]"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
              <button
                onClick={toggleLive}
                className={`flex h-9 items-center gap-2 rounded-full border px-4 text-xs font-semibold transition ${
                  isLive
                    ? 'border-white bg-white text-black hover:bg-[#e2e2e2]'
                    : 'border-[#333333] bg-[#121212] text-[#e5e2e1] hover:border-white/60'
                }`}
                title={realtimeError || undefined}
              >
                <span className={`h-2 w-2 rounded-full ${
                  isLive && realtimeConnected ? 'bg-black' : isLive ? 'bg-[#777777]' : 'bg-[#444748]'
                }`} />
                {isLive ? (realtimeConnected ? 'Realtime' : 'Live') : 'Paused'}
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <NetworkStat label="Agents" value={graph.summary.agents.toLocaleString()} tone="strong" />
            <NetworkStat label="Connections" value={graph.summary.edges.toLocaleString()} />
            <NetworkStat label="Orchestrators" value={graph.summary.orchestrators.toLocaleString()} />
            <NetworkStat label="RAG agents" value={graph.summary.ragAgents.toLocaleString()} />
            <NetworkStat label="Errors" value={graph.summary.totalErrors.toLocaleString()} />
          </div>
        </div>

        {truncated && (
          <div className="px-6 pt-5">
            <TruncationBanner range="the selected graph range" />
          </div>
        )}

        <div className="p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[1.5rem] border border-[#333333] bg-[#121212] px-4 py-3 text-xs text-[#8e9192]">
            <GitBranch className="h-4 w-4 text-[#e5e2e1]" />
            <span><strong className="text-white">Collaboration modes:</strong> orchestrator, sub-agent, peer, and solo are derived from actual parent/child agent spans and shared trace/session context.</span>
            {graph.summary.totalErrors > 0 && (
              <span className="ml-auto flex items-center gap-1.5 text-[#ffb4ab]">
                <AlertTriangle className="h-3.5 w-3.5" /> Error nodes are highlighted in the error tone.
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
