/**
 * Shared API authentication primitives — sha256 + rate limiter
 * (Upstash Redis with per-isolate fallback).
 *
 * Used by /api/ingest, /api/events, and /api/mcp so they don't each
 * re-implement (and drift on) the same logic.
 *
 * NOTE: As of audit finding #1's second pass, this module no longer
 * exports a per-isolate key cache. The previous version did, and
 * DELETE /api/settings/api-keys/[id] called invalidateAllKeyCaches()
 * to clear it on revoke. That fix was correct in unit tests but a
 * no-op in production: Vercel compiles each /api route as a separate
 * serverless function with its own bundled copy of this module, so
 * the DELETE function's invalidateAllKeyCaches() call could not reach
 * the ingest/events function's in-memory Map — they were never the
 * same process. Revocation lag was unchanged from before.
 *
 * The real fix is to not cache at all: every keyed route now hits
 * Supabase fresh on every request, matching /api/mcp's existing
 * pattern (resolveApiKeyByKeyHash). The key_hash column has a unique
 * index (idx_api_keys_key_hash, see supabase/migrations/0001), so
 * the lookup is a sub-millisecond point-read — no cache needed at
 * the volumes this service sees. Revocation now takes effect in 0
 * seconds across all routes, with no shared-store dependency.
 *
 * If traffic ever justifies re-introducing a cache, use Upstash Redis
 * (already wired up for the rate limiter below) so the cache is shared
 * across all serverless function instances — not an in-process Map,
 * which gives per-instance stale reads under Vercel's deployment model.
 *
 * Trade-off note (ingest vs mcp call patterns): mcp is occasional
 * ad-hoc tool invocations; ingest is the SDK's background worker
 * flushing every _BATCH_FLUSH_TIMEOUT = 2.0s under continuous load,
 * so a single actively-traced process is up to ~30 ingest calls/min
 * on the same key. Removing the cache turns that path from 1 DB hit
 * per 5 min per active key into up to 30/min per active key — ~150x
 * more lookups on ingest specifically. At current scale this is
 * nothing (indexed point-lookups handle thousands/sec on Postgres;
 * 100 concurrent traced agents is only ~50 req/s). If it ever matters,
 * it'll surface as PostgREST connection pressure, not query latency.
 */

import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

// ── sha256Hex ──────────────────────────────────────────────────────────────
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Rate limiter factory ───────────────────────────────────────────────────
// Distributed (Upstash Redis) when env configured; per-isolate fallback
// otherwise. Each route creates its own instance with its own prefix
// (so buckets don't collide) and its own limit (ingest/mcp: 120, events: 500).
//
// NOTE: the per-isolate fallback for rate limiting is fine even though it
// means "effective limit = RATE_LIMIT × n_isolates" — rate limiting is
// about abuse prevention, not exact quotas, and being permissive under
// fallback is safer than blocking legitimate traffic. The key-cache case
// was different: per-isolate caching created a security gap (stale revoked
// keys), which is why the cache was removed entirely rather than kept as
// a per-isolate fallback.

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  check(keyHash: string): Promise<boolean>
}

export function createRateLimiter(opts: {
  limit: number
  prefix: string
  windowMs?: number
}): RateLimiter {
  const { limit, prefix } = opts
  const windowMs = opts.windowMs ?? 60_000

  let upstash: Ratelimit | null = null

  function getUpstash(): Ratelimit | null {
    if (upstash) return upstash
    const url   = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN
    if (!url || !token) return null
    upstash = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(limit, '60 s'),
      analytics: false,
      prefix,
    })
    return upstash
  }

  // Per-isolate fallback (used when Upstash env vars are absent).
  interface RateEntry { count: number; windowStart: number }
  const rateMap = new Map<string, RateEntry>()

  function checkLocal(keyHash: string): boolean {
    const now   = Date.now()
    const entry = rateMap.get(keyHash)
    if (!entry || now - entry.windowStart > windowMs) {
      rateMap.set(keyHash, { count: 1, windowStart: now })
      return true
    }
    if (entry.count >= limit) return false
    entry.count++
    return true
  }

  return {
    async check(keyHash: string): Promise<boolean> {
      const limiter = getUpstash()
      if (limiter) {
        const { success } = await limiter.limit(keyHash)
        return success
      }
      return checkLocal(keyHash)
    },
  }
}
