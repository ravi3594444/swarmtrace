/**
 * MCP server (Streamable HTTP) so MCP-compatible agents like Claude Desktop
 * or Cursor can send traces without the Python SDK.
 *
 * Example client config:
 *   url: https://swarmtrace.vercel.app/api/mcp
 *   headers: { x-api-key: <your key> }
 *
 * Tools: record_trace, get_metrics, list_traces.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { sha256Hex, createRateLimiter, createIpRateLimiter, getClientIp } from '@/lib/api-auth'
import { resolveTraceIdentity } from '@/lib/resolve-trace-identity'
import { sanitizeMcpTraceFields } from '@/lib/sanitize-mcp-trace'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SUPA_TIMEOUT = 5000

async function supa(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    signal: AbortSignal.timeout(SUPA_TIMEOUT),
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
      ...((opts.headers as Record<string, string>) ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  return res.json()
}

async function supaRpc(fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    signal: AbortSignal.timeout(SUPA_TIMEOUT),
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase RPC ${fn} ${res.status}: ${text}`)
  }
}

// Rate limiter: 120 requests/min per API key, prefix 'st_mcp_rl' so it
// doesn't share buckets with ingest or events.
const RATE_LIMIT = 120
const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_mcp_rl' })
// Per-IP limiter runs before the per-key one (lib/api-auth.ts).
const ipRateLimiter = createIpRateLimiter({ prefix: 'st_ip_rl_mcp' })

// Looks the key up in Supabase on every call, no caching (see lib/api-auth.ts).

// Takes the precomputed keyHash so we don't hash twice per request.
async function resolveApiKeyByKeyHash(keyHash: string): Promise<string | null> {
  const rows: Array<{ user_id: string }> = await supa(
    `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`
  )
  return rows?.[0]?.user_id ?? null
}

// Stateless: a new McpServer per request.
function buildMcpServer(userId: string, keyHash: string): McpServer {
  const server = new McpServer({
    name:    'swarmtrace',
    version: '1.0.0',
  })

  // record_trace
  server.tool(
    'record_trace',
    'Record one agent trace into SwarmTrace. Call this after every observed function completes.',
    {
      id:            z.string().max(64).describe('Unique trace ID (e.g. UUID)'),
      function:      z.string().max(256).describe('Name of the observed function / agent step'),
      timestamp:     z.string().describe('ISO 8601 start timestamp'),
      latency_sec:   z.number().min(0).describe('Wall-clock duration in seconds'),
      input_tokens:  z.number().int().min(0).default(0).describe('Tokens sent to the model'),
      output_tokens: z.number().int().min(0).default(0).describe('Tokens returned by the model'),
      cost_usd:      z.number().min(0).default(0).describe('Cost in USD for this call'),
      args:          z.string().max(32000).optional().describe('Serialised function arguments'),
      output:        z.string().max(32000).optional().describe('Serialised function return value'),
      error:         z.string().max(32000).optional().describe('Error message if the call failed'),
      parent_id:     z.string().max(64).optional().describe('Parent trace ID for nested spans'),
      kind:          z.enum(['agent', 'tool', 'llm', 'function', 'retrieval']).default('agent').describe(
        'Span type. Nested steps (tool/llm/function/retrieval) must pass agent_id explicitly — MCP calls are stateless, there is no enclosing-agent context to infer it from the way the Python SDK\'s contextvars can.'
      ),
      agent_id:      z.string().max(64).optional().describe(
        'Stable agent identity. Required when kind is not "agent" (MCP has no enclosing-agent context to derive it from). When kind is "agent" and this is omitted, derived from `function` (SHA-256) so repeat calls aggregate into one dashboard card. Pass an explicit unique value per call ONLY if you want each call to be its own agent card.'
      ),
      agent_name:    z.string().max(256).optional().describe(
        'Display name for the agent card. Defaults to `function`.'
      ),
      session_id:    z.string().max(64).optional().describe(
        'Conversation/session id to group multi-turn runs into one thread. Optional.'
      ),
      trace_id:      z.string().max(64).optional().describe(
        'Distributed root run id. Optional; defaults to the span id.'
      ),
      attributes:    z.record(z.any()).optional().describe(
        'Generic JSON metadata for the span (e.g. tool name, provider). Optional.'
      ),
    },
    async (params) => {
      try {
        // Single RPC that upserts the trace and bumps daily_metrics only on a
        // fresh insert, so client retries don't double-count. See migration
        // 0007. Agent identity resolution is in lib/resolve-trace-identity.ts.
        const identity = resolveTraceIdentity({
          kind: params.kind,
          agent_id: params.agent_id,
          agent_name: params.agent_name,
          function: params.function,
        })
        if (!identity.ok) {
          return {
            content: [{ type: 'text', text: identity.error }],
            isError: true,
          }
        }
        const { kind, agentId, agentName } = identity

        // MCP clients skip the SDK's redaction, so truncate args/output/error
        // to MAX_TEXT_LEN and redact PII here, and cap attributes at 64 KB
        // JSON, same as /api/ingest. Invalid attributes reject the call.
        const sanitized = sanitizeMcpTraceFields({
          args: params.args,
          output: params.output,
          error: params.error,
          attributes: params.attributes,
        })
        if (!sanitized.ok) {
          return {
            content: [{ type: 'text', text: sanitized.error }],
            isError: true,
          }
        }

        // tenant stamped from the API key inside Postgres (migration 0010)
        await supaRpc('upsert_trace_for_key', {
          p_key_hash:      keyHash,
          p_id:            params.id,
          p_parent_id:     params.parent_id ?? null,
          p_trace_id:      params.trace_id ?? params.id,
          p_function:      params.function,
          p_args:          sanitized.value.args,
          p_output:        sanitized.value.output,
          p_latency_sec:   params.latency_sec,
          p_error:         sanitized.value.error,
          p_timestamp:     params.timestamp,
          p_input_tokens:  params.input_tokens  ?? 0,
          p_output_tokens: params.output_tokens ?? 0,
          p_cost_usd:      params.cost_usd      ?? 0,
          p_kind:          kind,
          p_agent_id:      agentId,
          p_agent_name:    agentName,
          p_session_id:    params.session_id ?? null,
          p_attributes:    sanitized.value.attributes,
        })

        return {
          content: [{ type: 'text', text: `✓ Trace recorded: ${params.function} (${params.id})` }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error recording trace: ${String(err)}` }],
          isError: true,
        }
      }
    },
  )

  // get_metrics
  server.tool(
    'get_metrics',
    'Get your SwarmTrace usage metrics — cost, token counts, and trace volume for today, 7 days, this month, and all time.',
    {},
    async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const rows: Array<{
          date: string
          total_cost: number
          input_tokens: number
          output_tokens: number
          trace_count: number
        }> = await supa(
          `daily_metrics?user_id=eq.${encodeURIComponent(userId)}&order=date.desc&limit=90`
        )

        const sum = (filter: (r: typeof rows[0]) => boolean) =>
          rows.filter(filter).reduce(
            (acc, r) => ({
              cost:   acc.cost   + (r.total_cost     || 0),
              input:  acc.input  + (r.input_tokens   || 0),
              output: acc.output + (r.output_tokens  || 0),
              traces: acc.traces + (r.trace_count    || 0),
            }),
            { cost: 0, input: 0, output: 0, traces: 0 },
          )

        const todayDate   = new Date(today)
        const sevenDaysAgo = new Date(todayDate); sevenDaysAgo.setDate(todayDate.getDate() - 6)
        const monthStart  = new Date(today.slice(0, 7) + '-01')

        const t  = sum(r => r.date === today)
        const w  = sum(r => new Date(r.date) >= sevenDaysAgo)
        const m  = sum(r => new Date(r.date) >= monthStart)
        const al = sum(() => true)

        const fmt = (n: number) => `$${n.toFixed(6)}`
        const fmtK = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n)

        return {
          content: [{
            type: 'text',
            text: [
              '📊 SwarmTrace Metrics',
              '',
              `Today:       ${fmt(t.cost)}  |  ${fmtK(t.input+t.output)} tokens  |  ${t.traces} traces`,
              `Last 7 days: ${fmt(w.cost)}  |  ${fmtK(w.input+w.output)} tokens  |  ${w.traces} traces`,
              `This month:  ${fmt(m.cost)}  |  ${fmtK(m.input+m.output)} tokens  |  ${m.traces} traces`,
              `All time:    ${fmt(al.cost)}  |  ${fmtK(al.input+al.output)} tokens  |  ${al.traces} traces`,
            ].join('\n'),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error fetching metrics: ${String(err)}` }],
          isError: true,
        }
      }
    },
  )

  // list_traces
  server.tool(
    'list_traces',
    'List your most recent agent traces from SwarmTrace.',
    {
      limit:  z.number().int().min(1).max(50).default(10).describe('Number of traces to return (max 50)'),
      filter: z.string().optional().describe('Optional function name to filter by'),
    },
    async ({ limit = 10, filter }) => {
      try {
        let path = `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=${limit}`
        if (filter) path += `&function=eq.${encodeURIComponent(filter)}`

        const rows: Array<{
          id: string
          function: string
          timestamp: string
          latency_sec: number
          input_tokens: number
          output_tokens: number
          cost_usd: number
          error: string | null
        }> = await supa(path)

        if (!rows || rows.length === 0) {
          return { content: [{ type: 'text', text: 'No traces found.' }] }
        }

        const lines = rows.map(r => {
          const ts      = new Date(r.timestamp).toLocaleString()
          const latency = `${r.latency_sec.toFixed(2)}s`
          const tokens  = r.input_tokens + r.output_tokens
          const cost    = `$${(r.cost_usd || 0).toFixed(6)}`
          const status  = r.error ? '❌' : '✓'
          return `${status} ${r.function.padEnd(30)} ${ts}  ${latency.padStart(7)}  ${String(tokens).padStart(6)} tok  ${cost}`
        })

        return {
          content: [{
            type: 'text',
            text: [
              `Recent traces (${rows.length}):`,
              `${'fn'.padEnd(32)} timestamp                  latency   tokens    cost`,
              '─'.repeat(90),
              ...lines,
            ].join('\n'),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error fetching traces: ${String(err)}` }],
          isError: true,
        }
      }
    },
  )

  return server
}

async function handleMcp(req: Request): Promise<Response> {
  // Auth: X-API-Key header (same as /api/ingest)
  const apiKey = req.headers.get('x-api-key') ?? req.headers.get('X-API-Key')
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Missing x-api-key header' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const keyHash = await sha256Hex(apiKey)

  // Per-IP limit first, so rotating fake keys doesn't buy fresh buckets
  const clientIp = getClientIp(req)
  if (!await ipRateLimiter.check(clientIp)) {
    return new Response(null, {
      status: 429,
      headers: {
        'Retry-After':       '60',
        'X-RateLimit-Scope': 'ip',
      },
    })
  }

  // Per-key rate limit (120/min), before the DB lookup
  if (!await rateLimiter.check(keyHash)) {
    return new Response(null, {
      status: 429,
      headers: {
        'Retry-After':       '60',
        'X-RateLimit-Limit':  String(RATE_LIMIT),
        'X-RateLimit-Window': '60s',
      },
    })
  }

  let userId: string | null = null
  try {
    userId = await resolveApiKeyByKeyHash(keyHash)
  } catch {
    return new Response(
      JSON.stringify({ error: 'Auth check failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (!userId) {
    return new Response(
      JSON.stringify({ error: 'Invalid or revoked API key' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // Stateless transport: one instance per request
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  })

  const server = buildMcpServer(userId, keyHash)

  try {
    await server.connect(transport)
    const response = await transport.handleRequest(req)
    await server.close()
    return response
  } catch (err) {
    console.error('[api/mcp] error:', err)
    return new Response(
      JSON.stringify({ error: 'MCP server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

export const GET    = handleMcp
export const POST   = handleMcp
export const DELETE = handleMcp
