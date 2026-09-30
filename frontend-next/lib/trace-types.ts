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
  // groups multi-turn runs into one conversation (swarmtrace 0.5.0)
  session_id?: string | null
  // generic JSON metadata for each span
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
  // Not a real column; some callers check `total_cost ?? cost_usd`, so it's
  // optional to keep that type-checking.
  total_cost?: number
}
