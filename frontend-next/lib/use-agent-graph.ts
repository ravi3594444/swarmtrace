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

// Realtime is scoped per agent_id, so it reports status changes for known
// agents but not brand-new ones. Topology still needs a periodic re-fetch;
// with status coming from Realtime this interval can be long.
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

  // Re-fetch right away when isLive flips back to true.
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (isLive && !wasLive.current) load()
    wasLive.current = isLive
  }, [isLive, load])

  // pauses on hidden tabs
  useVisibleInterval(load, pollMs, isLive)

  // Patch node status from Realtime without waiting for the next topology poll.
  const agentIds = useMemo(() => graph.nodes.map((node) => node.id), [graph.nodes])
  const presence = useAgentPresence(isLive ? agentIds : [])

  // Status signature ("agentId:status" pairs) so the liveGraph memo only
  // recomputes when a node's status really changes, not on every presence
  // object.
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
