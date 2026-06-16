export const runtime = 'edge'

// ── FOV event ingest ──────────────────────────────────────────────────────────
// Receives live agent activity events from tracely.fov and inserts them into
// the agent_events Supabase table.  Supabase Realtime then pushes to the
// browser via WebSocket — Vercel is completely out of the real-time path.
//
// Auth: same X-API-Key header as /api/ingest. Key cache is per-isolate.
// Rate limit: 500 events / 60s per API key (higher than traces — events are
// smaller and arrive more frequently during active agent runs).

const MAX_BODY_BYTES  = 32 * 1024   // 32 KB per event (screenshots compress well)
const SUPA_TIMEOUT_MS = 3000
const CACHE_TTL_MS    = 5 * 60 * 1000
const RATE_LIMIT      = 500
const RATE_WINDOW_MS  = 60_000

interface CacheEntry { user_id: string; expires: number }
const KEY_CACHE = new Map<string, CacheEntry>()

function getCached(hash: string): string | null {
  const e = KEY_CACHE.get(hash)
  if (!e) return null
  if (Date.now() > e.expires) { KEY_CACHE.delete(hash); return null }
  return e.user_id
}
function setCache(hash: string, user_id: string) {
  KEY_CACHE.set(hash, { user_id, expires: Date.now() + CACHE_TTL_MS })
}

interface RateEntry { count: number; windowStart: number }
const RATE_MAP = new Map<string, RateEntry>()

function checkRate(keyHash: string): boolean {
  const now = Date.now()
  const e   = RATE_MAP.get(keyHash)
  if (!e || now - e.windowStart > RATE_WINDOW_MS) {
    RATE_MAP.set(keyHash, { count: 1, windowStart: now })
    return true
  }
  if (e.count >= RATE_LIMIT) return false
  e.count++
  return true
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const VALID_TYPES   = new Set(['browser', 'llm_token', 'http', 'file'])
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

  // data can be anything serialisable; screenshots (base64) live here
  let data: unknown = v.data ?? {}
  if (typeof data !== 'object') data = { value: String(data) }

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

  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return json(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    if (!checkRate(keyHash)) {
      return new Response(null, { status: 429, headers: { 'Retry-After': '60' } })
    }

    let user_id = getCached(keyHash)
    if (!user_id) {
      const res = await supa(
        `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      const rows: Array<{ user_id: string }> = await res.json()
      if (!rows?.length) return json(401, { error: 'Invalid or revoked API key' })
      user_id = rows[0].user_id
      setCache(keyHash, user_id)
    }

    let payload: unknown
    try { payload = await req.json() }
    catch { return json(400, { error: 'Body must be valid JSON' }) }

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
