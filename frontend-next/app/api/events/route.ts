// Runs on the Node.js runtime (Vercel's default) — see app/api/ingest/route.ts
// for why this project doesn't use 'edge': Vercel deprecated standalone Edge
// Functions in June 2025, and Node.js/Fluid compute has full API support
// with none of the Edge runtime's Web-API gaps.

// ── FOV event ingest ──────────────────────────────────────────────────────────
// Receives live agent activity events from swarmtrace.fov and inserts them into
// the agent_events Supabase table.  Supabase Realtime then pushes to the
// browser via WebSocket — Vercel is completely out of the real-time path.
//
// Auth: same X-API-Key header as /api/ingest. Fresh Supabase lookup on
// every request — no in-process cache (see lib/api-auth.ts for why:
// Vercel's per-route serverless functions can't share memory, so a
// per-isolate cache gave stale revoked keys for up to 5 min in production).
// Rate limit: 500 events / 60s per API key.
//   - Upstash Redis (distributed): enabled when UPSTASH_REDIS_REST_URL is set.
//   - Per-isolate fallback: used otherwise. Note that Vercel can run many
//     isolates simultaneously — the effective limit is 500 × n_isolates when
//     Upstash is not configured.
//
// Body encoding: Content-Encoding: gzip is supported (audit finding #6),
// matching /api/ingest — see lib/decode-body.ts. No current SDK version
// sends it for events (swarmtrace.fov posts one uncompressed event per
// request), so this is dormant capability, not a live optimization yet.

import { sha256Hex, createRateLimiter, createIpRateLimiter, getClientIp } from '@/lib/api-auth'
import { decodeGzipBody } from '@/lib/decode-body'
import { redactDeep } from '@/lib/redact'

const MAX_BODY_BYTES  = 32 * 1024   // 32 KB per event (screenshots compress well)
// Decompressed-size bound (audit finding #6). No SDK version sends
// Content-Encoding: gzip for events today — swarmtrace.fov posts one
// event per request, uncompressed — so this is future-proofing, not a
// live capability being exercised in production yet. Sized generously
// relative to MAX_BODY_BYTES (not equal to it) so that if/when a future
// SDK batches multiple screen_tick events into one gzip-compressed POST
// (the same shape /api/ingest already supports), this route doesn't need
// another round of changes. Mirrors the ingest route's reasoning in
// lib/decode-body.ts; sized down from ingest's 1 MB since a single event
// (even with a base64 screenshot) has a much smaller legitimate ceiling.
const MAX_DECOMPRESSED_BYTES = 256 * 1024
const SUPA_TIMEOUT_MS = 3000
const RATE_LIMIT      = 500

const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_fov_rl' })
// Per-IP limiter runs BEFORE the per-key limiter — caps attackers who
// rotate fake API keys. See lib/api-auth.ts::createIpRateLimiter.
// 600/60s is high enough that a single FOV-enabled agent (which posts
// ~1 event per browser action + 1 screen_tick per SCREEN_INTERVAL=1s,
// so ~60/min just from screenshots) never hits it under normal use.
const ipRateLimiter = createIpRateLimiter({ prefix: 'st_ip_rl_events' })

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 'screen_tick' = FOV daemon screenshot captures (swarmtrace.fov). Without
// it in this set, screenshot events were silently flattened to 'browser'.
const VALID_TYPES   = new Set(['browser', 'llm_token', 'http', 'file', 'screen_tick'])
const VALID_STATUSES = new Set(['started', 'done', 'error', 'streaming', 'info'])

function validate(p: unknown): { row?: Record<string, unknown>; error?: string } {
  if (typeof p !== 'object' || p === null) return { error: 'Body must be a JSON object' }
  const v = p as Record<string, unknown>

  if (typeof v.id !== 'string' || !v.id)          return { error: 'id required' }
  if (typeof v.agent_id !== 'string' || !v.agent_id) return { error: 'agent_id required' }
  if (typeof v.timestamp !== 'string' || Number.isNaN(Date.parse(v.timestamp)))
    return { error: 'timestamp must be ISO 8601' }

  const event_type = typeof v.event_type === 'string' && VALID_TYPES.has(v.event_type)
    ? v.event_type : 'browser'
  const status = typeof v.status === 'string' && VALID_STATUSES.has(v.status)
    ? v.status : 'info'

  // data can be anything serialisable; screenshots (base64) live here.
  // Reviewer P1 fix: apply redactDeep() to scrub PII from event data
  // BEFORE it hits Supabase. The SDK already redacts client-side, but
  // any client that posts directly (curl, MCP, a third-party port)
  // bypasses the SDK. Server-side redaction is defense-in-depth so PII
  // never lands in the DB regardless of which client sent it.
  let data: unknown = v.data ?? {}
  if (typeof data !== 'object') data = { value: String(data) }
  data = redactDeep(data)

  return {
    row: {
      id:          v.id.slice(0, 64),
      agent_id:    (v.agent_id as string).slice(0, 64),
      agent_name:  typeof v.agent_name === 'string' ? v.agent_name.slice(0, 256) : null,
      event_type,
      status,
      data,
      timestamp:   v.timestamp,
    },
  }
}

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return json(401, { error: 'Missing X-API-Key' })

  // Read the actual bytes — Content-Length is client-supplied and optional,
  // so checking the header alone can be bypassed by omitting it entirely.
  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return json(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return json(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // Per-IP rate limit (BEFORE per-key — caps key-rotation attacks).
    // See lib/api-auth.ts::createIpRateLimiter for the full reasoning.
    const clientIp = getClientIp(req)
    if (!await ipRateLimiter.check(clientIp)) {
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '60', 'X-RateLimit-Scope': 'ip' },
      })
    }

    if (!await rateLimiter.check(keyHash)) {
      return new Response(null, { status: 429, headers: { 'Retry-After': '60' } })
    }

    // Fresh Supabase lookup on every request — no in-process cache.
    // See ingest/route.ts for the full reasoning.
    const res = await supa(
      `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
      { headers: { Prefer: 'return=representation' } }
    )
    const rows: Array<{ user_id: string }> = await res.json()
    if (!rows?.length) return json(401, { error: 'Invalid or revoked API key' })
    const user_id = rows[0].user_id

    let payload: unknown
    try {
      payload = JSON.parse(await decodeGzipBody(bodyBytes, req.headers.get('content-encoding'), MAX_DECOMPRESSED_BYTES))
    } catch { return json(400, { error: 'Body must be valid JSON (gzip supported via Content-Encoding: gzip)' }) }

    const { row, error } = validate(payload)
    if (!row) return json(400, { error })

    await supa('agent_events', {
      method: 'POST',
      body: JSON.stringify({ ...row, user_id }),
    })

    return new Response(null, { status: 204 })
  } catch (err) {
    console.error('[api/events] failed:', err)
    return json(500, { error: 'Internal server error' })
  }
}
