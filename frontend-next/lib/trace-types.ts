export type Trace = {
  id: string
  parent_id: string | null
  function: string
  args: string
  output: string
  latency_sec: number
  error: string | null
  timestamp: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
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
