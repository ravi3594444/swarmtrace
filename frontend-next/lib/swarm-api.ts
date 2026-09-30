import {
  fetchTraces as fetchTracesRaw,
  fetchAgents as fetchAgentsRaw,
  fetchGraph as fetchGraphRaw,
} from './api'
import { rangeStartMs, type TimeRangeKey } from './trace-utils'
import type { AgentNetworkGraph } from './agent-network'
import type { Trace, Agent } from './trace-types'

type ApiSpan = {
  id: string
  parent_id: string | null
  trace_id?: string | null
  function: string
  args: string
  output: string
  duration: number // ms
  tokens_in: number
  tokens_out: number
  cost: number
  timestamp: string
  error: string | null
  kind?: string
  agent_id?: string
  agent_name?: string
  session_id?: string | null
  attributes?: Record<string, unknown> | null
}

function toTrace(s: ApiSpan): Trace {
  return {
    id: s.id,
    parent_id: s.parent_id ?? null,
    trace_id: s.trace_id ?? null,
    function: s.function ?? '(unknown)',
    args: s.args ?? '',
    output: s.output ?? '{}',
    latency_sec: (s.duration ?? 0) / 1000,
    error: s.error ?? null,
    timestamp: s.timestamp ?? new Date().toISOString(),
    input_tokens: s.tokens_in ?? 0,
    output_tokens: s.tokens_out ?? 0,
    cost_usd: s.cost ?? 0,
    kind: (s.kind as 'agent' | 'tool' | 'llm' | 'function' | 'retrieval') ?? undefined,
    agent_id: s.agent_id,
    agent_name: s.agent_name,
    session_id: s.session_id ?? null,
    attributes: s.attributes ?? null,
  }
}

/** Traces plus `truncated`, true when /api/traces returned the full 500 rows and more probably exist. */
export interface TracesResult {
  traces: Trace[]
  truncated: boolean
}

export async function fetchSwarmTraces(since?: number | null): Promise<TracesResult> {
  const data = await fetchTracesRaw(since)
  return {
    traces: (data?.traces ?? []).map(toTrace),
    truncated: Boolean(data?.truncated),
  }
}

/** Agents plus `truncated`, true when the underlying traces query hit the 500-row cap (older-only agents may be missing). */
export interface AgentsResult {
  agents: Agent[]
  truncated: boolean
}

export async function fetchSwarmAgents(range: TimeRangeKey = 'today'): Promise<AgentsResult> {
  // Lower bound is computed in the browser's local timezone; the server only
  // compares numbers. 'all' gives null, so no ?since param.
  const since = rangeStartMs(range)
  const data = await fetchAgentsRaw(since)
  return {
    agents: data?.agents ?? [],
    truncated: Boolean(data?.truncated),
  }
}

export interface AgentGraphResult {
  graph: AgentNetworkGraph
  truncated: boolean
}

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

export async function fetchSwarmGraph(range: TimeRangeKey = 'today'): Promise<AgentGraphResult> {
  const since = rangeStartMs(range)
  const data = await fetchGraphRaw(since)
  return {
    graph: data?.graph ?? EMPTY_GRAPH,
    truncated: Boolean(data?.truncated),
  }
}
