export type Trace = {
  id: string
  parent_id: string | null
  trace_id?: string | null
  function: string
  args: string
  output: string
  latency_sec: number
  error: string | null
  timestamp: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  // added in swarmtrace 0.3.0
  kind?: 'agent' | 'tool' | 'llm' | 'function' | 'retrieval'
  agent_id?: string
  agent_name?: string
  // added in swarmtrace 0.5.0 — groups multi-turn runs into one conversation
  session_id?: string | null
  // added in Phase 5 — generic JSON metadata for each span
  attributes?: Record<string, unknown> | null
}

export type Agent = {
  id: string
  name: string
  status: 'RUNNING' | 'IDLE' | 'ERROR'
  tasks: number
  tokens: string
  lastActive: string
  uptime: string
  success_rate: string
  current_task: string
}

// Row shape of public.daily_metrics (see supabase/migrations/0002_daily_metrics.sql).
export type DailyMetricRow = {
  date: string
  cost_usd: number
  input_tokens: number
  output_tokens: number
  trace_count: number
  // Not a real column in the current schema — some callers defensively
  // check `total_cost ?? cost_usd` anyway; kept optional so that pattern
  // still type-checks without implying the column actually exists.
  total_cost?: number
}
