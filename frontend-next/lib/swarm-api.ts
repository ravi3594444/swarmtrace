import { fetchTraces as fetchTracesRaw, fetchAgents as fetchAgentsRaw } from './api'
import type { Trace, Agent } from './trace-types'
import { DEMO_TRACES } from './trace-types'

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
  }
}

export type TracesResult = { traces: Trace[]; source: 'api' | 'demo' }

export async function fetchSwarmTraces(): Promise<TracesResult> {
  const data = await fetchTracesRaw()
  const traces: Trace[] = (data?.traces ?? []).map(toTrace)
  return traces.length ? { traces, source: 'api' } : { traces: DEMO_TRACES, source: 'demo' }
}

const DEMO_AGENTS: Agent[] = [
  {
    id: 'ext-8829', name: 'DataExtractor_v2', status: 'RUNNING',
    tasks: 12, tokens: '2.4M', lastActive: '2 min ago', uptime: '14d 2h',
    success_rate: '99.2%', current_task: 'Extracting Q3 earnings...',
  },
  {
    id: 'agt-1024', name: 'CodeAnalyzer_Beta', status: 'IDLE',
    tasks: 8, tokens: '1.8M', lastActive: '1h ago', uptime: '6d 11h',
    success_rate: '96.7%', current_task: 'Idle',
  },
]

export type AgentsResult = { agents: Agent[]; source: 'api' | 'demo' }

export async function fetchSwarmAgents(): Promise<AgentsResult> {
  const data = await fetchAgentsRaw()
  const agents: Agent[] = data?.agents ?? []
  return agents.length ? { agents, source: 'api' } : { agents: DEMO_AGENTS, source: 'demo' }
}
