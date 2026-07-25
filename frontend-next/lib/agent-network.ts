import type { Trace } from './trace-types'

export type CollaborationMode = 'solo' | 'orchestrator' | 'sub_agent' | 'peer'
export type AgentNodeStatus = 'RUNNING' | 'IDLE' | 'ERROR'
export type AgentEdgeRelation = 'orchestrates' | 'peer'

export type AgentGraphNode = {
  id: string
  label: string
  status: AgentNodeStatus
  collaborationMode: CollaborationMode
  runs: number
  spans: number
  errors: number
  tokens: number
  cost: number
  avgLatencySec: number
  lastActive: string
  latestTraceId: string
  llmSpans: number
  toolSpans: number
  ragSpans: number
  functionSpans: number
  sessions: string[]
  traces: string[]
}

export type AgentGraphEdge = {
  id: string
  source: string
  target: string
  relation: AgentEdgeRelation
  calls: number
  errors: number
  traceIds: string[]
  sessionIds: string[]
}

export type AgentNetworkSummary = {
  agents: number
  edges: number
  orchestrators: number
  subAgents: number
  peerAgents: number
  soloAgents: number
  ragAgents: number
  totalTokens: number
  totalCost: number
  totalErrors: number
}

export type AgentNetworkGraph = {
  nodes: AgentGraphNode[]
  edges: AgentGraphEdge[]
  summary: AgentNetworkSummary
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const KNOWN_KINDS = new Set(['agent', 'llm', 'tool', 'retrieval', 'function'])

function toMs(timestamp: string | undefined): number {
  const ms = timestamp ? new Date(timestamp).getTime() : NaN
  return Number.isFinite(ms) ? ms : 0
}

function traceKind(trace: Trace): NonNullable<Trace['kind']> {
  return trace.kind && KNOWN_KINDS.has(trace.kind) ? trace.kind : 'function'
}

function traceGroupKey(trace: Trace): string {
  return trace.trace_id || trace.session_id || trace.parent_id || trace.id
}

function isRetrievalLike(trace: Trace): boolean {
  const name = (trace.function || '').toLowerCase()
  return traceKind(trace) === 'retrieval' || name.includes('retriev') || name.includes('rag')
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string | null | undefined) {
  if (!value) return
  const set = map.get(key)
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}

function addEdge(
  edges: Map<string, AgentGraphEdge>,
  edge: Omit<AgentGraphEdge, 'id'>,
) {
  if (edge.source === edge.target) return
  const pair = edge.relation === 'peer'
    ? [edge.source, edge.target].sort().join('->')
    : `${edge.source}->${edge.target}`
  const key = `${edge.relation}:${pair}`
  const existing = edges.get(key)
  if (!existing) {
    edges.set(key, { id: key, ...edge })
    return
  }
  existing.calls += edge.calls
  existing.errors += edge.errors
  for (const tid of edge.traceIds) {
    if (!existing.traceIds.includes(tid)) existing.traceIds.push(tid)
  }
  for (const sid of edge.sessionIds) {
    if (!existing.sessionIds.includes(sid)) existing.sessionIds.push(sid)
  }
}

function nearestAgentAncestor(
  span: Trace,
  byId: Map<string, Trace>,
): Trace | null {
  let parentId = span.parent_id
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) return null
    if (traceKind(parent) === 'agent' && parent.agent_id) return parent
    parentId = parent.parent_id
  }
  return null
}

export function deriveAgentNetworkGraph(
  traces: Trace[],
  now: Date = new Date(),
): AgentNetworkGraph {
  const byId = new Map(traces.map((trace) => [trace.id, trace]))
  const agentSpans = traces.filter((trace) => traceKind(trace) === 'agent' && trace.agent_id)
  const agentIds = new Set(agentSpans.map((trace) => trace.agent_id as string))

  const rowsByAgent = new Map<string, Trace[]>()
  for (const trace of traces) {
    if (!trace.agent_id || !agentIds.has(trace.agent_id)) continue
    const rows = rowsByAgent.get(trace.agent_id)
    if (rows) rows.push(trace)
    else rowsByAgent.set(trace.agent_id, [trace])
  }

  const edges = new Map<string, AgentGraphEdge>()
  const peerGroups = new Map<string, Set<string>>()
  const traceIdsByGroup = new Map<string, Set<string>>()
  const sessionsByGroup = new Map<string, Set<string>>()

  for (const agentSpan of agentSpans) {
    const agentId = agentSpan.agent_id as string
    const parentAgent = nearestAgentAncestor(agentSpan, byId)
    if (parentAgent?.agent_id && parentAgent.agent_id !== agentId) {
      addEdge(edges, {
        source: parentAgent.agent_id,
        target: agentId,
        relation: 'orchestrates',
        calls: 1,
        errors: agentSpan.error ? 1 : 0,
        traceIds: [agentSpan.trace_id || agentSpan.id].filter(Boolean),
        sessionIds: [agentSpan.session_id].filter(Boolean) as string[],
      })
    }

    const groupKey = traceGroupKey(agentSpan)
    addToSetMap(peerGroups, groupKey, agentId)
    addToSetMap(traceIdsByGroup, groupKey, agentSpan.trace_id || agentSpan.id)
    addToSetMap(sessionsByGroup, groupKey, agentSpan.session_id)
  }

  const hasOrchestrationBetween = (a: string, b: string) => {
    return edges.has(`orchestrates:${a}->${b}`) || edges.has(`orchestrates:${b}->${a}`)
  }

  for (const [groupKey, ids] of peerGroups) {
    const sortedIds = Array.from(ids).sort((a, b) => {
      const aFirst = agentSpans.find((trace) => trace.agent_id === a && traceGroupKey(trace) === groupKey)
      const bFirst = agentSpans.find((trace) => trace.agent_id === b && traceGroupKey(trace) === groupKey)
      return toMs(aFirst?.timestamp) - toMs(bFirst?.timestamp)
    })
    if (sortedIds.length < 2) continue
    for (let i = 0; i < sortedIds.length - 1; i += 1) {
      const source = sortedIds[i]
      const target = sortedIds[i + 1]
      if (hasOrchestrationBetween(source, target)) continue
      addEdge(edges, {
        source,
        target,
        relation: 'peer',
        calls: 1,
        errors: 0,
        traceIds: Array.from(traceIdsByGroup.get(groupKey) || []),
        sessionIds: Array.from(sessionsByGroup.get(groupKey) || []),
      })
    }
  }

  const edgeList = Array.from(edges.values()).sort((a, b) => b.calls - a.calls)
  const outgoingOrchestrates = new Map<string, number>()
  const incomingOrchestrates = new Map<string, number>()
  const peerCounts = new Map<string, number>()
  for (const edge of edgeList) {
    if (edge.relation === 'orchestrates') {
      outgoingOrchestrates.set(edge.source, (outgoingOrchestrates.get(edge.source) || 0) + edge.calls)
      incomingOrchestrates.set(edge.target, (incomingOrchestrates.get(edge.target) || 0) + edge.calls)
    } else {
      peerCounts.set(edge.source, (peerCounts.get(edge.source) || 0) + edge.calls)
      peerCounts.set(edge.target, (peerCounts.get(edge.target) || 0) + edge.calls)
    }
  }

  const nodes = Array.from(rowsByAgent.entries()).map(([agentId, rows]) => {
    const sorted = [...rows].sort((a, b) => toMs(b.timestamp) - toMs(a.timestamp))
    const latest = sorted[0]
    const agentRows = rows.filter((trace) => traceKind(trace) === 'agent')
    const tokens = rows.reduce(
      (sum, trace) => sum + (trace.input_tokens || 0) + (trace.output_tokens || 0),
      0,
    )
    const cost = rows.reduce((sum, trace) => sum + (trace.cost_usd || 0), 0)
    const errors = rows.filter((trace) => trace.error).length
    const latency = rows.reduce((sum, trace) => sum + (trace.latency_sec || 0), 0)
    const latestMs = toMs(latest?.timestamp)
    const status: AgentNodeStatus = latest?.error
      ? 'ERROR'
      : now.getTime() - latestMs <= FIVE_MINUTES_MS ? 'RUNNING' : 'IDLE'
    const collaborationMode: CollaborationMode = outgoingOrchestrates.has(agentId)
      ? 'orchestrator'
      : incomingOrchestrates.has(agentId)
        ? 'sub_agent'
        : peerCounts.has(agentId) ? 'peer' : 'solo'

    return {
      id: agentId,
      label: agentRows[0]?.agent_name || latest?.agent_name || agentId,
      status,
      collaborationMode,
      runs: agentRows.length,
      spans: rows.length,
      errors,
      tokens,
      cost,
      avgLatencySec: rows.length > 0 ? latency / rows.length : 0,
      lastActive: latest?.timestamp || '',
      latestTraceId: latest?.id || agentRows[0]?.id || agentId,
      llmSpans: rows.filter((trace) => traceKind(trace) === 'llm').length,
      toolSpans: rows.filter((trace) => traceKind(trace) === 'tool').length,
      ragSpans: rows.filter(isRetrievalLike).length,
      functionSpans: rows.filter((trace) => traceKind(trace) === 'function').length,
      sessions: Array.from(new Set(rows.map((trace) => trace.session_id).filter(Boolean) as string[])),
      traces: Array.from(new Set(rows.map((trace) => trace.trace_id || trace.id).filter(Boolean))),
    }
  }).sort((a, b) => {
    const modeRank: Record<CollaborationMode, number> = {
      orchestrator: 0,
      sub_agent: 1,
      peer: 2,
      solo: 3,
    }
    return modeRank[a.collaborationMode] - modeRank[b.collaborationMode]
      || toMs(b.lastActive) - toMs(a.lastActive)
  })

  const summary: AgentNetworkSummary = {
    agents: nodes.length,
    edges: edgeList.length,
    orchestrators: nodes.filter((node) => node.collaborationMode === 'orchestrator').length,
    subAgents: nodes.filter((node) => node.collaborationMode === 'sub_agent').length,
    peerAgents: nodes.filter((node) => node.collaborationMode === 'peer').length,
    soloAgents: nodes.filter((node) => node.collaborationMode === 'solo').length,
    ragAgents: nodes.filter((node) => node.ragSpans > 0).length,
    totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
    totalCost: nodes.reduce((sum, node) => sum + node.cost, 0),
    totalErrors: nodes.reduce((sum, node) => sum + node.errors, 0),
  }

  return { nodes, edges: edgeList, summary }
}
