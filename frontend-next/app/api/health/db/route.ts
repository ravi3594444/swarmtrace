// GET /api/health/db — self-diagnostic for the dashboard's database setup.
//
// Public (no auth): it exposes only which of this open-source project's own
// schema objects exist — no user data, no key material. Per-IP rate limited
// (30/min) and cached briefly per isolate so monitors can poll it without
// hammering PostgREST.
//
//   200 { ok: true,  checks: [...] }                                  — healthy
//   503 { ok: false, checks: [...], missingMigrations: [...], hint }  — degraded
//   503 { ok: false, error: 'not_configured' }                        — env missing
//
// Root-cause context: before this endpoint existed, a deployment whose
// Supabase migrations were never applied failed /api/ingest with an opaque
// 500, and the only way to find out was reading Vercel logs. This endpoint
// is the answer to "traces aren't showing up — where do I even look?"

import { checkSchemaHealth } from '@/lib/schema-health'
import { createIpRateLimiter, getClientIp } from '@/lib/api-auth'

// 30/min/IP is plenty for a human + an uptime monitor; the work below costs
// ~14 trivial PostgREST calls per uncached hit.
const ipRateLimiter = createIpRateLimiter({ limit: 30, prefix: 'st_ip_rl_health' })

// Per-isolate cache. Health flips rarely (someone ran migrations or the DB
// went down); 30 s staleness is fine for a diagnostic endpoint and keeps
// polling clients cheap. Vercel note: each isolate caches independently —
// harmless here (no correctness requirement, just load shaping).
const CACHE_TTL_MS = 30_000
let cache: { at: number; status: number; body: unknown } | null = null

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never let a CDN serve someone else's (or yesterday's) health state
      // from the edge cache.
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
    // Not cached: env changes flip isolates anyway, and a deployment with
    // missing env should see the miss every time in its logs.
    return jsonResponse(503, body)
  }

  const result = await checkSchemaHealth({ url, serviceKey })
  const status = result.ok ? 200 : 503
  cache = { at: Date.now(), status, body: result }
  return jsonResponse(status, result, { 'X-Health-Cache': 'miss' })
}
