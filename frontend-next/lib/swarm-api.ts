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

/**
 * Traces + whether the backend capped the result at the 500-row limit.
 *
 * `truncated` is true when /api/traces returned exactly 500 rows — signals
 * that more rows likely exist beyond what's displayed. The dashboard
 * surfaces this via <TruncationBanner /> so users know to narrow their
 * date filter instead of assuming the older data doesn't exist.
 *
 * Audit finding #4 follow-up: previously this function did
 * `data?.traces ?? []` and dropped `truncated` on the floor. The backend
 * was computing it (commit 2475287) but no client ever saw it.
 */
export interface TracesResult {
  traces: Trace[]
  truncated: boolean
}

export async function fetchSwarmTraces(): Promise<TracesResult> {
  const data = await fetchTracesRaw()
  return {
    traces: (data?.traces ?? []).map(toTrace),
    truncated: Boolean(data?.truncated),
  }
}

/**
 * Agents + whether the backend capped the underlying traces query at 500 rows.
 *
 * Same `truncated` semantics as fetchSwarmTraces — true means the Agents
 * page is built from a capped trace set, so some agents that only have
 * traces older than the 500th-most-recent may not appear. Narrowing the
 * date range (which the Agents page already supports via the time-range
 * dropdown) is the user-facing fix.
 */
export interface AgentsResult {
  agents: Agent[]
  truncated: boolean
}

export async function fetchSwarmAgents(range: TimeRangeKey = 'today'): Promise<AgentsResult> {
  // Compute the inclusive lower-bound timestamp in the user's LOCAL timezone
  // (rangeStartMs uses the browser's Date). The server just does a numeric
  // comparison — no TZ logic on the server, which keeps it correct regardless
  // of the server's TZ (Vercel runs UTC by default).
  // 'all' → rangeStartMs returns null → no ?since param → no filter.
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
