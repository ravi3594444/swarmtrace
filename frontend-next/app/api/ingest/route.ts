export const runtime = 'edge'

const MAX_BODY_BYTES  = 64 * 1024
const MAX_TEXT_LEN    = 4000
const SUPA_TIMEOUT_MS = 5000

// ── Key auth cache ────────────────────────────────────────────────────────────
// NOTE: Vercel Edge is serverless — this Map lives per-isolate, not globally.
// It still helps: repeated requests within the same warm isolate skip a DB
// lookup. For a true shared cache, use Vercel KV or Upstash Redis.
interface CacheEntry { user_id: string; expires: number }
const KEY_CACHE    = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCached(hash: string): string | null {
  const entry = KEY_CACHE.get(hash)
  if (!entry) return null
  if (Date.now() > entry.expires) { KEY_CACHE.delete(hash); return null }
  return entry.user_id
}
function setCache(hash: string, user_id: string) {
  KEY_CACHE.set(hash, { user_id, expires: Date.now() + CACHE_TTL_MS })
}

// ── Distributed rate limiter (Upstash Redis) ──────────────────────────────────
// Falls back to per-isolate map if UPSTASH_REDIS_REST_URL is not set.
// To enable: add UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to Vercel env.
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

let upstashLimiter: Ratelimit | null = null

function getUpstashLimiter(): Ratelimit | null {
  if (upstashLimiter) return upstashLimiter
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  upstashLimiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(120, '60 s'),
    analytics: false,
    prefix: 'st_rl',
  })
  return upstashLimiter
}

// ── Per-isolate fallback (used when Upstash env vars are absent) ──────────────
// 120 requests per 60-second window per API key.
const RATE_LIMIT     = 120
const RATE_WINDOW_MS = 60_000

interface RateEntry { count: number; windowStart: number }
const RATE_MAP = new Map<string, RateEntry>()

function checkRateLimitLocal(keyHash: string): boolean {
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

async function checkRateLimit(keyHash: string): Promise<boolean> {
  const limiter = getUpstashLimiter()
  if (limiter) {
    const { success } = await limiter.limit(keyHash)
    return success
  }
  return checkRateLimitLocal(keyHash)
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function supa(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...((opts.headers as Record<string, string>) || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  return res
}

async function supaRpc(fn: string, params: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    signal: AbortSignal.timeout(SUPA_TIMEOUT_MS),
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase RPC ${fn} ${res.status}: ${text}`)
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const VALID_KINDS = new Set(['agent', 'tool', 'llm', 'function'])

function validateTrace(payload: unknown): { row?: Record<string, unknown>; error?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { error: 'Body must be a JSON object' }
  const p = payload as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64)
    return { error: 'id must be a non-empty string of at most 64 characters' }
  if (typeof p.function !== 'string' || p.function.length === 0 || p.function.length > 256)
    return { error: 'function must be a non-empty string of at most 256 characters' }
  if (typeof p.timestamp !== 'string' || Number.isNaN(Date.parse(p.timestamp)))
    return { error: 'timestamp must be a valid ISO 8601 string' }
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : '')
  const num  = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  // kind/agent_id/agent_name were added in swarmtrace 0.3.0. Older SDK versions
  // (or anything posting to /ingest directly) won't send them — default to
  // kind='agent', agent_id=id, agent_name=function, which reproduces the
  // pre-0.3.0 "every trace is its own agent" behavior exactly, so old
  // clients keep working without becoming phantom sub-agents of anything.
  const kind = typeof p.kind === 'string' && VALID_KINDS.has(p.kind) ? p.kind : 'agent'
  const agentId =
    typeof p.agent_id === 'string' && p.agent_id.length > 0 ? p.agent_id.slice(0, 64) : p.id
  const agentName =
    typeof p.agent_name === 'string' && p.agent_name.length > 0
      ? p.agent_name.slice(0, 256)
      : p.function

  return {
    row: {
      id:            p.id,
      parent_id:     typeof p.parent_id === 'string' ? p.parent_id.slice(0, 64) : null,
      function:      p.function,
      args:          text(p.args),
      output:        text(p.output),
      latency_sec:   num(p.latency_sec),
      error:         typeof p.error === 'string' ? p.error.slice(0, MAX_TEXT_LEN) : null,
      timestamp:     p.timestamp,
      input_tokens:  Math.max(0, Math.trunc(num(p.input_tokens))),
      output_tokens: Math.max(0, Math.trunc(num(p.output_tokens))),
      cost_usd:      Math.max(0, num(p.cost_usd)),
      kind:          kind,
      agent_id:      agentId,
      agent_name:    agentName,
    },
  }
}

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // ── Rate limit check (before DB lookup — cheap, fast) ─────────────────
    if (!await checkRateLimit(keyHash)) {
      return new Response(null, {
        status: 429,
        headers: {
          'Retry-After': '60',
          'X-RateLimit-Limit':  String(RATE_LIMIT),
          'X-RateLimit-Window': '60s',
        },
      })
    }

    let user_id = getCached(keyHash)
    if (!user_id) {
      const res = await supa(
        `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      const rows: Array<{ user_id: string }> = await res.json()
      if (!rows || rows.length === 0)
        return jsonResponse(401, { error: 'Invalid or revoked API key' })
      user_id = rows[0].user_id
      setCache(keyHash, user_id)
    }

    let payload: unknown
    try { payload = await req.json() }
    catch { return jsonResponse(400, { error: 'Body must be valid JSON' }) }

    const { row, error } = validateTrace(payload)
    if (!row) return jsonResponse(400, { error })

    // ── 1. Upsert trace (idempotent — safe on network retry) ─────────────────
    await supaRpc('upsert_trace', {
      p_id:            row.id,
      p_user_id:       user_id,
      p_parent_id:     row.parent_id ?? null,
      p_function:      row.function,
      p_args:          row.args,
      p_output:        row.output,
      p_latency_sec:   row.latency_sec,
      p_error:         row.error ?? null,
      p_timestamp:     row.timestamp,
      p_input_tokens:  row.input_tokens,
      p_output_tokens: row.output_tokens,
      p_cost_usd:      row.cost_usd,
      p_kind:          row.kind,
      p_agent_id:      row.agent_id,
      p_agent_name:    row.agent_name,
    })

    // ── 2. Atomically increment daily_metrics — powers the dashboard ──────
    await supaRpc('increment_daily_metrics', {
      p_user_id:       user_id,
      p_cost:          row.cost_usd,
      p_input_tokens:  row.input_tokens,
      p_output_tokens: row.output_tokens,
    })

    // ── 3. Update last_used (non-fatal) ───────────────────────────────────
    try {
      await supa(`api_keys?key_hash=eq.${encodeURIComponent(keyHash)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_used: new Date().toISOString() }),
      })
    } catch { /* cosmetic only */ }

    return new Response(null, { status: 204 })
  } catch (err) {
    console.error('[api/ingest] request failed:', err)
    return jsonResponse(500, { error: 'Internal server error' })
  }
}
