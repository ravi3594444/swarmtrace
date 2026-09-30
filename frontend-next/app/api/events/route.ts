// Node.js runtime, same reasoning as app/api/ingest/route.ts.
//
// Receives live agent activity events from swarmtrace.fov and inserts them
// into agent_events; Supabase Realtime pushes them to the browser.
//
// Auth is the X-API-Key header, looked up fresh on every request (see
// lib/api-auth.ts). Rate limit is 500 events/min per key, via Upstash when
// configured, otherwise per isolate (so effectively 500 x isolates).
//
// Gzip bodies are supported like /api/ingest (lib/decode-body.ts), though no
// SDK sends them for events yet.

import { sha256Hex, createRateLimiter, createIpRateLimiter, getClientIp } from '@/lib/api-auth'
import { decodeGzipBody } from '@/lib/decode-body'
import { redactEventData } from '@/lib/redact'
// Insert failures are classified like /api/ingest, so a missing migration
// 0010 (PGRST202) says so instead of "Internal server error".
import { classifySupabaseError, ingestErrorBody } from '@/lib/ingest-errors'

const MAX_BODY_BYTES  = 32 * 1024   // 32 KB per event
// Decompressed-size bound. No SDK sends gzipped events today; this is sized
// above MAX_BODY_BYTES in case batched screen_ticks show up later.
const MAX_DECOMPRESSED_BYTES = 256 * 1024
const SUPA_TIMEOUT_MS = 3000
const RATE_LIMIT      = 500

const rateLimiter = createRateLimiter({ limit: RATE_LIMIT, prefix: 'st_fov_rl' })
// Per-IP limiter runs before the per-key one. 600/min leaves room for one
// FOV agent (about 60/min from screenshots alone).
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
  return res
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 'screen_tick' is the FOV daemon's screenshot event (swarmtrace.fov).
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

  // data can be anything serialisable (screenshots are base64 in here).
  // Redact before persisting, since direct clients skip the SDK: fill/type
  // values, token chunks and URL query secrets.
  let data: unknown = v.data ?? {}
  if (typeof data !== 'object') data = { value: String(data) }
  data = redactEventData(event_type, data)

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

  // Read the actual bytes, Content-Length is client-supplied and optional.
  let bodyBytes: ArrayBuffer
  try { bodyBytes = await req.arrayBuffer() }
  catch { return json(400, { error: 'Could not read request body' }) }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return json(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // Per-IP limit first, so rotating fake keys doesn't buy fresh buckets.
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

    // Existence probe for a clean 401; the tenant is stamped in Postgres by
    // insert_agent_event_for_key (migration 0010).
    const res = await supa(
      `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
      { headers: { Prefer: 'return=representation' } }
    )
    const rows: Array<{ user_id: string }> = await res.json()
    if (!rows?.length) return json(401, { error: 'Invalid or revoked API key' })

    let payload: unknown
    try {
      payload = JSON.parse(await decodeGzipBody(bodyBytes, req.headers.get('content-encoding'), MAX_DECOMPRESSED_BYTES))
    } catch { return json(400, { error: 'Body must be valid JSON (gzip supported via Content-Encoding: gzip)' }) }

    const { row, error } = validate(payload)
    if (!row) return json(400, { error })

    // Key-bound insert: user_id comes from the key inside Postgres, never
    // from the request body.
    await supaRpc('insert_agent_event_for_key', {
      p_key_hash:   keyHash,
      p_id:         row.id,
      p_agent_id:   row.agent_id,
      p_event_type: row.event_type,
      p_status:     row.status,
      p_agent_name: row.agent_name,
      p_data:       row.data ?? null,
      p_timestamp:  row.timestamp,
    })

    return new Response(null, { status: 204 })
  } catch (err) {
    const classified = classifySupabaseError(err)
    console.error('[api/events] failed:', classified.code, err)
    return json(500, ingestErrorBody(classified))
  }
}
