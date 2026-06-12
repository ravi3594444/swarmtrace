// ─── Edge runtime — Web Crypto only (Node's `crypto` module is NOT available here) ─
export const runtime = 'edge'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB per trace payload
const MAX_TEXT_LEN = 4000 // matches SDK-side truncation
const SUPA_TIMEOUT_MS = 5000

// ─── Module-level key cache — survives across requests in the same instance ─
// Maps SHA-256(apiKey) → { user_id, expires }
// TTL: 5 minutes. On cache miss we hit Supabase once, then cache.
// NOTE: a revoked key may keep working for up to CACHE_TTL_MS per instance.
interface CacheEntry { user_id: string; expires: number }
const KEY_CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min

function getCached(hash: string): string | null {
  const entry = KEY_CACHE.get(hash)
  if (!entry) return null
  if (Date.now() > entry.expires) { KEY_CACHE.delete(hash); return null }
  return entry.user_id
}

function setCache(hash: string, user_id: string) {
  KEY_CACHE.set(hash, { user_id, expires: Date.now() + CACHE_TTL_MS })
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Supabase REST helper (inline — edge runtime can't import server-only lib) ─
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

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Payload validation (no external deps — keeps the edge bundle tiny) ────
function validateTrace(payload: unknown): { row?: Record<string, unknown>; error?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { error: 'Body must be a JSON object' }
  }
  const p = payload as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) {
    return { error: 'id must be a non-empty string of at most 64 characters' }
  }
  if (typeof p.function !== 'string' || p.function.length === 0 || p.function.length > 256) {
    return { error: 'function must be a non-empty string of at most 256 characters' }
  }
  if (typeof p.timestamp !== 'string' || Number.isNaN(Date.parse(p.timestamp))) {
    return { error: 'timestamp must be a valid ISO 8601 string' }
  }
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT_LEN) : '')
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    row: {
      id: p.id,
      parent_id: typeof p.parent_id === 'string' ? p.parent_id.slice(0, 64) : null,
      function: p.function,
      args: text(p.args),
      output: text(p.output),
      latency_sec: num(p.latency_sec),
      error: typeof p.error === 'string' ? p.error.slice(0, MAX_TEXT_LEN) : null,
      timestamp: p.timestamp,
      input_tokens: Math.max(0, Math.trunc(num(p.input_tokens))),
      output_tokens: Math.max(0, Math.trunc(num(p.output_tokens))),
      cost_usd: Math.max(0, num(p.cost_usd)),
    },
  }
}

// ─── POST /api/ingest ────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) return jsonResponse(401, { error: 'Missing X-API-Key header' })

  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'Payload too large' })

  try {
    const keyHash = await sha256Hex(apiKey)

    // ── 1. Resolve key → user_id (cache-first) ─────────────────────────────
    let user_id = getCached(keyHash)
    if (!user_id) {
      const res = await supa(
        `api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      const rows: Array<{ user_id: string }> = await res.json()
      if (!rows || rows.length === 0) {
        return jsonResponse(401, { error: 'Invalid or revoked API key' })
      }
      user_id = rows[0].user_id
      setCache(keyHash, user_id)
    }

    // ── 2. Parse + validate payload ─────────────────────────────────────────
    let payload: unknown
    try {
      payload = await req.json()
    } catch {
      return jsonResponse(400, { error: 'Body must be valid JSON' })
    }
    const { row, error } = validateTrace(payload)
    if (!row) return jsonResponse(400, { error })

    // ── 3. INSERT trace (scoped to the resolved tenant) ─────────────────────
    await supa('traces', { method: 'POST', body: JSON.stringify({ ...row, user_id }) })

    // ── 4. Update last_used. Awaited: edge instances may cancel dangling
    // promises after the response returns. Failures are non-fatal.
    try {
      await supa(`api_keys?key_hash=eq.${encodeURIComponent(keyHash)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_used: new Date().toISOString() }),
      })
    } catch { /* last_used is cosmetic only */ }

    return new Response(null, { status: 204 })
  } catch (err) {
    console.error('[api/ingest] request failed:', err)
    return jsonResponse(500, { error: 'Internal server error' })
  }
}
