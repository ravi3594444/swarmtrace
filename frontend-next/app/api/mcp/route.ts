/**
 * SwarmTrace MCP Server
 * ─────────────────────
 * Implements the Model Context Protocol (Streamable HTTP transport) so any
 * MCP-compatible agent (Hermes, Claude Desktop, Cursor, etc.) can connect
 * and send traces without the Python SDK.
 *
 * Hermes config.yaml example:
 *   mcp_servers:
 *     swarmtrace:
 *       url: "https://swarmtrace.vercel.app/api/mcp"
 *       transport: streamable-http
 *       headers:
 *         x-api-key: "your_swarmtrace_api_key"
 *
 * Exposes three tools:
 *   record_trace  — send one trace (mirrors POST /api/ingest)
 *   get_metrics   — fetch your current usage stats
 *   list_traces   — fetch recent traces
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { stableAgentId } from '@/lib/stable-agent-id'

// ── Supabase helpers ──────────────────────────────────────────────────────────
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

// ── Rate limiter (Upstash Redis with per-isolate fallback) ──────────────────
// Same pattern as /api/ingest and /api/events. 120 requests / 60s per API key.
// Falls back to per-isolate Map when UPSTASH_REDIS_REST_URL is not set.
// To enable: add UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to Vercel env.
const RATE_LIMIT     = 120
const RATE_WINDOW_MS = 60_000

let _upstashLimiter: Ratelimit | null = null

function getUpstashLimiter(): Ratelimit | null {
  if (_upstashLimiter) return _upstashLimiter
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  _upstashLimiter = new Ratelimit({
    redis:     new Redis({ url, token }),
    limiter:   Ratelimit.slidingWindow(RATE_LIMIT, '60 s'),
    analytics: false,
    prefix:    'st_mcp_rl',
  })
  return _upstashLimiter
}

interface RateEntry { count: number; windowStart: number }
const RATE_MAP = new Map<string, RateEntry>()

function checkRateLocal(keyHash: string): boolean {
  const now   = Date.now()
  const entry = RATE_MAP.get(keyHash)
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    RATE_MAP.set(keyHash, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= RATE_LIMIT) return false
  entry.count++
  return true
}

async function checkRate(keyHash: string): Promise<boolean> {
  const limiter = getUpstashLimiter()
  if (limiter) {
    const { success } = await limiter.limit(keyHash)
    return success
  }
  return checkRateLocal(keyHash)
}

// ── API key → user_id resolution ─────────────────────────────────────────────
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Accepts a pre-computed keyHash (same one used for rate limiting) so we
// don't hash the API key twice per request.
async function resolveApiKeyByKeyHash(keyHash: string): Promise<string | null> {
  const rows: Array<{ user_id: string }> = await supa(
    `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`
  )
  return rows?.[0]?.user_id ?? null
}

// ── MCP server factory ────────────────────────────────────────────────────────
// Stateless — a new McpServer instance per request (perfect for serverless).
function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name:    'swarmtrace',
    version: '1.0.0',
  })

  // ── Tool: record_trace ───────────────────────────────────────────────────
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
      args:          z.string().max(4000).optional().describe('Serialised function arguments'),
      output:        z.string().max(4000).optional().describe('Serialised function return value'),
      error:         z.string().max(4000).optional().describe('Error message if the call failed'),
      parent_id:     z.string().max(64).optional().describe('Parent trace ID for nested spans'),
      agent_id:      z.string().max(64).optional().describe(
        'Stable agent identity. If omitted, derived from `function` (SHA-256) so repeat calls aggregate into one dashboard card. Pass an explicit unique value per call ONLY if you want each call to be its own agent card.'
      ),
      agent_name:    z.string().max(256).optional().describe(
        'Display name for the agent card. Defaults to `function`.'
      ),
      session_id:    z.string().max(64).optional().describe(
        'Conversation/session id to group multi-turn runs into one thread. Optional.'
      ),
    },
    async (params) => {
      try {
        // ── Atomic upsert + metrics (idempotent on retry) ─────────────────
        // MCP clients (Claude Desktop, Cursor, etc.) retry on transient
        // network errors. Single RPC that upserts the trace AND increments
        // daily_metrics only if the trace was a fresh insert — so retries
        // don't double-count costs. See supabase/migrations/0007_atomic_ingest.sql.
        //
        // Agent identity (mirrors swarmtrace/tracer.py::_stable_agent_id):
        //   - If the caller passes an explicit `agent_id`, use it as-is.
        //   - Otherwise derive a STABLE id from `function` (SHA-256), so
        //     repeat calls of the same agent function aggregate into one
        //     dashboard card with tasks=N — matching the SDK's behavior
        //     for bare @observe.
        //   - kind is always 'agent' for MCP (the MCP tool IS the agent
        //     entry point; there's no nested tool/llm distinction here).
        //   - agent_name defaults to `function` if not provided.
        //
        // BEFORE this change, agent_id was hardcoded to params.id (fresh
        // per call), which meant every MCP call became its own agent card
        // with tasks=1 — inconsistent with the SDK. See
        // tests/test_tracer.py::test_api_agents_filter_contract and
        // frontend-next/scripts/test-derive-agent-cards.mjs.
        const kind      = 'agent'
        const agentId   = params.agent_id ?? stableAgentId(params.function)
        const agentName = params.agent_name ?? params.function

        await supaRpc('upsert_trace_with_metrics', {
          p_id:            params.id,
          p_user_id:       userId,
          p_parent_id:     params.parent_id ?? null,
          p_function:      params.function,
          p_args:          params.args    ?? '',
          p_output:        params.output  ?? '',
          p_latency_sec:   params.latency_sec,
          p_error:         params.error   ?? null,
          p_timestamp:     params.timestamp,
          p_input_tokens:  params.input_tokens  ?? 0,
          p_output_tokens: params.output_tokens ?? 0,
          p_cost_usd:      params.cost_usd      ?? 0,
          p_kind:          kind,
          p_agent_id:      agentId,
          p_agent_name:    agentName,
          p_session_id:    params.session_id ?? null,
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

  // ── Tool: get_metrics ────────────────────────────────────────────────────
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

  // ── Tool: list_traces ────────────────────────────────────────────────────
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

// ── Request handler ───────────────────────────────────────────────────────────
async function handleMcp(req: Request): Promise<Response> {
  // Auth — X-API-Key header (same as /api/ingest)
  const apiKey = req.headers.get('x-api-key') ?? req.headers.get('X-API-Key')
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Missing x-api-key header' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const keyHash = await sha256Hex(apiKey)

  // ── Rate limit check (before DB lookup — cheap, fast) ──────────────────
  // Same pattern as /api/ingest. 120 requests / 60s per API key.
  if (!await checkRate(keyHash)) {
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

  // Stateless transport — one instance per request, no session needed
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  })

  const server = buildMcpServer(userId)

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
