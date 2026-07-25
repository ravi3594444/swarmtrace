'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTraceRealtime } from '@/contexts/RealtimeContext'
import type { AgentNetworkGraph } from './agent-network'
import { fetchSwarmGraph } from './swarm-api'
import type { TimeRangeKey } from './trace-utils'

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

export function useAgentGraph(range: TimeRangeKey) {
  const [graph, setGraph] = useState<AgentNetworkGraph>(EMPTY_GRAPH)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(true)
  const mounted = useRef(true)
  const reqId = useRef(0)
  const realtime = useTraceRealtime(isLive)

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

  useEffect(() => {
    if (!isLive || realtime.version === 0) return
    load()
  }, [isLive, load, realtime.version])

  return {
    graph,
    truncated,
    loading,
    isLive,
    realtimeConnected: realtime.connected,
    realtimeError: realtime.error,
    refresh: load,
    toggleLive: () => setIsLive((value) => !value),
  }
}
