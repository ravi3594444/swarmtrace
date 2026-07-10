// Runs on the Node.js runtime (Vercel's default). DecompressionStream, used
// by decodeIngestBody() below for gzip-batched payloads, is not supported on
// Vercel's Edge runtime (confirmed via build: "A Node.js API is used
// (DecompressionStream) which is not supported in the Edge Runtime") — it
// would throw on every gzip-compressed batch send. Vercel also deprecated
// standalone Edge Functions in June 2025 in favor of Node.js/Fluid compute,
// which has full Web API + npm support, so there's no upside to staying on
// 'edge' here.

const MAX_BODY_BYTES  = 64 * 1024
const MAX_BATCH_SIZE = 50
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

// Validation logic lives in lib/validate-ingest.ts so it can be unit-tested
// without standing up the edge runtime. The route imports the shape-detector
// + validator; tests import the same functions directly.
import { validateIngest, decodeIngestBody, type TraceRow } from '@/lib/validate-ingest'

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  // Read the actual bytes — Content-Length is client-supplied and optional,
  // so checking the header alone can be bypassed by omitting it entirely.
  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return jsonResponse(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

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

    // The SDK's batch path gzips the body and sets Content-Encoding: gzip.
    // Request bodies are NOT auto-decompressed by the runtime, so inflate
    // explicitly (with a decompressed-size bound) before JSON-parsing.
    let payload: unknown
    try {
      payload = JSON.parse(await decodeIngestBody(bodyBytes, req.headers.get('content-encoding')))
    } catch { return jsonResponse(400, { error: 'Body must be valid JSON (gzip supported via Content-Encoding: gzip)' }) }

    const { rows, error } = validateIngest(payload)
    if (!rows) return jsonResponse(400, error)

    // Cap batch size — a single POST with 50 traces is fine; 5000 is a
    // runaway SDK or a misuse. Rejecting early keeps Supabase RPC latency
    // bounded and prevents one fat batch from starving other users.
    if (rows.length > MAX_BATCH_SIZE) {
      return jsonResponse(413, {
        error: `Batch too large: ${rows.length} traces (max ${MAX_BATCH_SIZE}). Split into smaller batches.`,
      })
    }

    // ── Insert each trace via the atomic upsert+metrics RPC ───────────────
    // One RPC per trace (not one per batch) because the RPC is itself atomic
    // per-row (ON CONFLICT DO UPDATE + conditional metrics increment). A
    // batch RPC would be a future optimization, but the current shape keeps
    // the migration surface small and the retry semantics identical to the
    // single-object path — if the batch fails mid-way, the SDK retries the
    // whole batch and every row is idempotent.
    //
    // On a confirmed-successful insert, the SDK marks the row synced=1 in
    // its local SQLite DB (task 3). If this whole batch RPC sequence fails,
    // the SDK leaves all rows synced=0 and the resync CLI replays them.
    for (const row of rows as TraceRow[]) {
      await supaRpc('upsert_trace_with_metrics', {
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
        p_session_id:    row.session_id ?? null,
      })
    }

    // ── 2. Update last_used (non-fatal) ───────────────────────────────────
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
