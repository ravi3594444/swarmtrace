import { fetchTraces as fetchTracesRaw, fetchAgents as fetchAgentsRaw } from './api'
import type { Trace, Agent } from './trace-types'

type ApiSpan = {
  id: string
  parent_id: string | null
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
}

function toTrace(s: ApiSpan): Trace {
  return {
    id: s.id,
    parent_id: s.parent_id ?? null,
    function: s.function ?? '(unknown)',
    args: s.args ?? '',
    output: s.output ?? '{}',
    latency_sec: (s.duration ?? 0) / 1000,
    error: s.error ?? null,
    timestamp: s.timestamp ?? new Date().toISOString(),
    input_tokens: s.tokens_in ?? 0,
    output_tokens: s.tokens_out ?? 0,
    cost_usd: s.cost ?? 0,
    kind: (s.kind as 'agent' | 'tool' | 'llm' | 'function') ?? undefined,
    agent_id: s.agent_id,
    agent_name: s.agent_name,
  }
}

export async function fetchSwarmTraces(): Promise<Trace[]> {
  const data = await fetchTracesRaw()
  return (data?.traces ?? []).map(toTrace)
}

export async function fetchSwarmAgents(): Promise<Agent[]> {
  const data = await fetchAgentsRaw()
  return data?.agents ?? []
}
