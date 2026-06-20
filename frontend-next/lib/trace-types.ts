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

// Shown (with a "DEMO DATA" badge) only when the real API returns zero
// traces — e.g. a brand-new account with no @observe-instrumented calls
// yet — so the dashboard never looks broken or empty on first load.
export const DEMO_TRACES: Trace[] = [
  {
    id: '84b4bd8a',
    parent_id: 'cb88a9ab',
    function: 'execute_task',
    args: '{"task": "Research and summarize Q4 earnings"}',
    output: '{"status": "completed", "summary": "Q4 revenue up 12% YoY..."}',
    latency_sec: 3.42,
    error: null,
    timestamp: '2026-06-04T10:14:22.001Z',
    input_tokens: 412,
    output_tokens: 188,
    cost_usd: 0.0021,
  },
  {
    id: 'a1b2c3d4',
    parent_id: '84b4bd8a',
    function: 'plan_steps',
    args: '{"goal": "Q4 earnings summary"}',
    output: '["fetch_filing", "extract_metrics", "summarize"]',
    latency_sec: 0.84,
    error: null,
    timestamp: '2026-06-04T10:14:22.110Z',
    input_tokens: 220,
    output_tokens: 90,
    cost_usd: 0.0008,
  },
  {
    id: 'f00dbabe',
    parent_id: 'a1b2c3d4',
    function: 'fetch_filing',
    args: '{"ticker": "ACME", "quarter": "Q4"}',
    output: '{"filing_url": "https://sec.gov/...", "bytes": 184230}',
    latency_sec: 1.12,
    error: null,
    timestamp: '2026-06-04T10:14:22.950Z',
    input_tokens: 64,
    output_tokens: 42,
    cost_usd: 0.0004,
  },
  {
    id: 'deadbeef',
    parent_id: 'a1b2c3d4',
    function: 'extract_metrics',
    args: '{"filing_url": "https://sec.gov/..."}',
    output: '',
    latency_sec: 0.62,
    error: 'TimeoutError: extraction exceeded 500ms budget',
    timestamp: '2026-06-04T10:14:24.080Z',
    input_tokens: 880,
    output_tokens: 0,
    cost_usd: 0.0011,
  },
  {
    id: '1234abcd',
    parent_id: 'a1b2c3d4',
    function: 'summarize',
    args: '{"text": "<filing body...>"}',
    output: '"Revenue grew 12% YoY driven by enterprise expansion."',
    latency_sec: 0.94,
    error: null,
    timestamp: '2026-06-04T10:14:24.720Z',
    input_tokens: 1240,
    output_tokens: 220,
    cost_usd: 0.0019,
  },
  {
    id: '9c8b7a65',
    parent_id: null,
    function: 'vector_search',
    args: '{"query": "prior guidance vs actuals"}',
    output: '{"hits": 5, "top_score": 0.91}',
    latency_sec: 0.38,
    error: null,
    timestamp: '2026-06-04T10:14:25.700Z',
    input_tokens: 80,
    output_tokens: 60,
    cost_usd: 0.0003,
  },
  {
    id: '5e5e5e5e',
    parent_id: '9c8b7a65',
    function: 'rerank',
    args: '{"hits": 5}',
    output: '',
    latency_sec: 0.21,
    error: 'RateLimitError: 429 from provider',
    timestamp: '2026-06-04T10:14:26.085Z',
    input_tokens: 200,
    output_tokens: 0,
    cost_usd: 0.0002,
  },
  {
    id: 'c0ffee11',
    parent_id: null,
    function: 'llm_call',
    args: '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Analyze earnings..."}]}',
    output: '{"choices": [{"message": {"content": "Based on the filing..."}}]}',
    latency_sec: 2.15,
    error: null,
    timestamp: '2026-06-04T10:14:27.000Z',
    input_tokens: 1500,
    output_tokens: 340,
    cost_usd: 0.0052,
  },
  {
    id: 'abe12345',
    parent_id: 'c0ffee11',
    function: 'tool_call',
    args: '{"name": "get_stock_price", "args": {"ticker": "ACME"}}',
    output: '{"price": 142.50, "change": "+2.3%"}',
    latency_sec: 0.31,
    error: null,
    timestamp: '2026-06-04T10:14:28.200Z',
    input_tokens: 45,
    output_tokens: 28,
    cost_usd: 0.0002,
  },
]
