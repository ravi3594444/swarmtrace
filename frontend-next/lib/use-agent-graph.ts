'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentGraphNode, AgentNetworkGraph } from './agent-network'
import { fetchSwarmGraph } from './swarm-api'
import type { TimeRangeKey } from './trace-utils'
import { useAgentPresence } from '@/contexts/RealtimeContext'
import { useVisibleInterval } from '@/hooks/use-visible-interval'

const EMPTY_GRAPH: AgentNetworkGraph = {
  nodes: [],
  edges: [],
  summary: {
    agents: 0,
    edges: 0,
    orchestrators: 0,
    subAgents: 0,
    peerAgents: 0,
    soloAgents: 0,
    ragAgents: 0,
    totalTokens: 0,
    totalCost: 0,
    totalErrors: 0,
  },
}

// Realtime channels (contexts/RealtimeContext.tsx) are scoped per agent_id,
// so they can tell us a *known* agent just changed status, but not that a
// brand-new agent_id started existing. Topology (nodes/edges appearing or
// disappearing) still needs a periodic full re-fetch; per-node status now
// comes from Realtime instead, so this interval can be much longer than the
// old 7-8s poll.
const TOPOLOGY_POLL_MS = 20000

export function useAgentGraph(range: TimeRangeKey, pollMs = TOPOLOGY_POLL_MS) {
  const [graph, setGraph] = useState<AgentNetworkGraph>(EMPTY_GRAPH)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(true)
  const mounted = useRef(true)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current
    const result = await fetchSwarmGraph(range)
    if (!mounted.current || id !== reqId.current) return
    setGraph(result.graph)
    setTruncated(result.truncated)
    setLoading(false)
  }, [range])

  useEffect(() => {
    mounted.current = true
    load()
    return () => { mounted.current = false }
  }, [load])

  // Re-fetch immediately when isLive flips back to true, so the user sees
  // fresh data right away instead of waiting up to pollMs.
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (isLive && !wasLive.current) load()
    wasLive.current = isLive
  }, [isLive, load])

  // Audit finding: this poller never paused on hidden tabs, so a
  // backgrounded tab kept re-fetching the topology every pollMs all night.
  useVisibleInterval(load, pollMs, isLive)

  // Patch node status instantly from the existing Supabase Realtime
  // channels, without waiting for the next topology poll above.
  const agentIds = useMemo(() => graph.nodes.map((node) => node.id), [graph.nodes])
  const presence = useAgentPresence(isLive ? agentIds : [])

  // Derive a stable "status signature" from presence so the liveGraph
  // memo doesn't recompute on every presence object identity change.
  // Previously `presence` was a new object on every realtime event, so
  // the memo recomputed the entire nodes array even when no visible
  // status actually changed. The signature is a string of
  // "agentId:status" pairs — only changes when a node's status actually
  // flips, which is rare. This keeps the memo stable across high-frequency
  // presence heartbeats while still updating instantly on real status changes.
  const presenceSignature = useMemo(() => {
    if (!isLive) return ''
    return agentIds
      .map((id) => `${id}:${presence[id]?.status ?? ''}`)
      .join('|')
  }, [agentIds, presence, isLive])

  const liveGraph = useMemo<AgentNetworkGraph>(() => {
    if (!isLive) return graph
    let changed = false
    const nodes: AgentGraphNode[] = graph.nodes.map((node) => {
      const p = presence[node.id]
      if (!p || !p.status || p.status === node.status) return node
      changed = true
      return { ...node, status: p.status, lastActive: p.lastEventAt ?? node.lastActive }
    })
    return changed ? { ...graph, nodes } : graph
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presenceSignature is the stable proxy for presence changes
  }, [graph, presenceSignature, isLive])

  return {
    graph: liveGraph,
    truncated,
    loading,
    isLive,
    refresh: load,
    toggleLive: () => setIsLive((value) => !value),
  }
}
