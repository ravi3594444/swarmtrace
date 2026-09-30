// GET /api/health/db: self-check for the database setup, answering "traces
// aren't showing up, where do I look?".
//
// Public, since it only reveals which of the project's own schema objects
// exist (no user data or keys). Per-IP rate limited (30/min) and cached
// briefly per isolate.
//
//   200 { ok: true, checks: [...] }
//   503 { ok: false, checks: [...], missingMigrations: [...], hint }
//   503 { ok: false, error: 'not_configured' }   (env missing)

import { checkSchemaHealth } from '@/lib/schema-health'
import { createIpRateLimiter, getClientIp } from '@/lib/api-auth'

// 30/min/IP is plenty; each uncached hit makes about 14 PostgREST calls.
const ipRateLimiter = createIpRateLimiter({ limit: 30, prefix: 'st_ip_rl_health' })

// Per-isolate cache; 30 s staleness is fine for a diagnostic endpoint.
const CACHE_TTL_MS = 30_000
let cache: { at: number; status: number; body: unknown } | null = null

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // keep CDNs from serving stale health state
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

export async function GET(req: Request) {
  if (!await ipRateLimiter.check(getClientIp(req))) {
    return jsonResponse(429, { error: 'Too many requests' }, { 'Retry-After': '60' })
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return jsonResponse(cache.status, cache.body, { 'X-Health-Cache': 'hit' })
  }

  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  if (!url || !serviceKey) {
    const body = {
      ok: false,
      error: 'not_configured',
      hint:
        'SUPABASE_URL and/or SUPABASE_SERVICE_KEY are not set on this ' +
        'deployment. Set them (Vercel → Project → Environment Variables for ' +
        'production, .env.local for dev), redeploy, then re-check. ' +
        'See docs/SUPABASE_SETUP.md.',
    }
    // not cached: a deployment with missing env should see it every time
    return jsonResponse(503, body)
  }

  const result = await checkSchemaHealth({ url, serviceKey })
  const status = result.ok ? 200 : 503
  cache = { at: Date.now(), status, body: result }
  return jsonResponse(status, result, { 'X-Health-Cache': 'miss' })
}
