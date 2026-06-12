import crypto from 'crypto'

// ─── Edge runtime — ~0ms cold start, runs in Vercel's global network ───────
export const runtime = 'edge'

// ─── Module-level key cache — survives across requests in the same instance ─
// Maps SHA-256(apiKey) → { user_id, expires }
// TTL: 5 minutes. On cache miss we hit Supabase once, then cache.
// This cuts the Supabase SELECT on every ingest call for repeat keys.
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

// ─── Supabase REST helper (inline — edge runtime can't import server-only lib) ─
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function supa(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(opts.headers as Record<string, string> || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  return res
}

// ─── POST /api/ingest ────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing X-API-Key header' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex')

  try {
    // ── 1. Resolve key → user_id (cache-first) ─────────────────────────────
    let user_id = getCached(keyHash)

    if (!user_id) {
      const res = await supa(
        `api_keys?key_hash=eq.${keyHash}&revoked=eq.false&select=user_id&limit=1`,
        { headers: { Prefer: 'return=representation' } }
      )
      const rows: Array<{ user_id: string }> = await res.json()
      if (!rows || rows.length === 0) {
        return new Response(JSON.stringify({ error: 'Invalid or revoked API key' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        })
      }
      user_id = rows[0].user_id
      setCache(keyHash, user_id)
    }

    // ── 2. Parse payload ────────────────────────────────────────────────────
    const payload = await req.json()

    const row = {
      id:            payload.id,
      user_id,
      parent_id:     payload.parent_id    || null,
      function:      payload.function,
      args:          payload.args         || '',
      output:        payload.output       || '',
      latency_sec:   payload.latency_sec  || 0.0,
      error:         payload.error        || null,
      timestamp:     payload.timestamp,
      input_tokens:  payload.input_tokens || 0,
      output_tokens: payload.output_tokens|| 0,
      cost_usd:      payload.cost_usd     || 0.0,
    }

    // ── 3. INSERT trace ─────────────────────────────────────────────────────
    await supa('traces', { method: 'POST', body: JSON.stringify(row) })

    // ── 4. PATCH last_used — fire-and-forget, does NOT block the response ──
    // Uses waitUntil equivalent: Promise without await.
    // If it fails, it's fine — last_used is cosmetic only.
    supa(`api_keys?key_hash=eq.${keyHash}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_used: new Date().toISOString() }),
    }).catch(() => {/* intentionally silent */})

    return new Response(null, { status: 204 })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
