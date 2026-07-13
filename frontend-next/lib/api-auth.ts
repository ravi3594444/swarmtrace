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
 *
 * ── Per-IP rate limit (audit fix: rate-limit bypass) ─────────────────────
 *
 * The per-key limiter below is keyed by sha256(apiKey). An attacker can
 * rotate random fake API keys, receiving a fresh bucket for each one
 * while still forcing a Supabase key-validity lookup on every request.
 * At 1000 fake keys/sec that's 1000 DB round-trips/sec and an arbitrary
 * number of "legitimate-looking" 401s — a cheap DoS that bypasses the
 * per-key limiter entirely. The fix: a per-IP rate limit that runs
 * BEFORE the per-key limit, so key rotation doesn't help. See
 * createIpRateLimiter() + getClientIp() below.
 */

import { isIP } from 'node:net'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

// ── sha256Hex ──────────────────────────────────────────────────────────────
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Client IP extraction ───────────────────────────────────────────────────
//
// Reviewer P2 fix: the first implementation trusted x-forwarded-for,
// x-vercel-forwarded-for, and x-real-ip unconditionally. On Vercel,
// x-forwarded-for is overwritten by the platform to prevent spoofing, so
// the production deployment is safe. But a self-hosted `next start`
// deployment or an incorrectly configured proxy lets an attacker rotate
// X-Forwarded-For values and obtain a new rate-limit bucket for every
// request.
//
// New behavior:
//   - On Vercel (VERCEL=1 or VERCEL_ENV set): trust x-forwarded-for and
//     x-vercel-forwarded-for (Vercel overwrites them to prevent spoofing).
//   - Off Vercel (self-hosted): do NOT trust client-supplied forwarded-for
//     headers. Use x-real-ip only if the operator explicitly sets
//     SWARMTRACE_TRUST_PROXY=1 (signaling they've configured their reverse
//     proxy to set x-real-ip correctly). Otherwise return 'unknown'.
//   - All extracted values are validated as IPv4 or IPv6. Invalid values
//     map to 'unknown' (shared bucket) so an attacker can't pollute the
//     rate-map with arbitrary strings.
//
// Returns 'unknown' when no valid IP can be extracted. 'unknown' shares
// one bucket — the safe default (no IP = one shared cap, not a fresh
// bucket per request).
//
// SELF-HOSTING NOTE: if you run `next start` behind a reverse proxy,
// set SWARMTRACE_TRUST_PROXY=1 and configure your proxy to overwrite
// x-real-ip with the client IP. Without this, all requests share one
// 'unknown' IP bucket, which is safe but coarse. For production-grade
// per-IP limiting on self-hosted deployments, enforce the limit at the
// reverse proxy / WAF (nginx limit_req, Cloudflare rate limiting, etc.)
// and also configure Upstash Redis for distributed limiting across
// multiple Node.js instances.

const _IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_ENV)

// Read SWARMTRACE_TRUST_PROXY at call time (not module-load time) so
// tests can toggle it. In production it's set once and never changes.
function _trustProxy(): boolean {
  return process.env.SWARMTRACE_TRUST_PROXY === '1'
}

// Validate with Node's parser rather than a permissive hand-written regex.
// Strip IPv6 zone IDs before using the value as a bucket key so one address
// cannot create arbitrary buckets by rotating `%zone` suffixes.
function _normalizeIp(ip: string): string | null {
  const bare = ip.trim().split('%')[0]
  return isIP(bare) ? bare.toLowerCase() : null
}

export function resolveClientIp(
  h: Headers,
  { isVercel, trustProxy }: { isVercel: boolean; trustProxy: boolean },
): string {
  if (isVercel) {
    // These headers are platform-managed on Vercel. Prefer the Vercel-named
    // header, then its documented x-forwarded-for equivalent.
    for (const name of ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip']) {
      const raw = h.get(name)
      const first = raw?.split(',')[0]?.trim()
      const ip = first ? _normalizeIp(first) : null
      if (ip) return ip
    }
    return 'unknown'
  }

  if (trustProxy) {
    // Self-hosting documentation requires the trusted reverse proxy to
    // overwrite x-real-ip. Do not also trust client-supplied XFF here: many
    // otherwise-correct proxies pass it through unchanged.
    const raw = h.get('x-real-ip')
    const ip = raw ? _normalizeIp(raw) : null
    return ip ?? 'unknown'
  }

  return 'unknown'
}

export function getClientIp(req: Request): string {
  return resolveClientIp(req.headers, {
    isVercel: _IS_VERCEL,
    trustProxy: _trustProxy(),
  })
}

/** Test-only: expose the Vercel detection flag for unit tests. */
export function _isVercel(): boolean {
  return _IS_VERCEL
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
  /** Test-only: number of distinct keys currently held in the per-isolate
   * fallback map (always 0 when Upstash is configured, since that path
   * never touches the map). Exists so the bounded-memory fix for audit
   * finding #7 can be regression-tested from outside the closure. */
  _debugMapSize?(): number
}

export function createRateLimiter(opts: {
  limit: number
  prefix: string
  windowMs?: number
  /** Test-only: how many check() calls between expired-entry sweeps of
   * the fallback map. Defaults to 500; tests can lower this to force a
   * sweep deterministically without 500 calls. */
  sweepEvery?: number
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
  // FIX #7: the map used to grow unbounded -- an entry was created for
  // every distinct keyHash ever seen and nothing ever deleted it, even
  // after its window expired. On a long-lived isolate (or in dev, where
  // Upstash env vars are typically absent) this is a slow memory leak
  // that scales with the number of distinct API keys seen over the
  // isolate's lifetime. Sweep expired entries periodically (every
  // SWEEP_EVERY calls, not every call, so the hot path stays O(1)) so
  // the map stays bounded by "keys active in the last windowMs", not
  // "keys ever seen".
  interface RateEntry { count: number; windowStart: number }
  const rateMap = new Map<string, RateEntry>()
  const SWEEP_EVERY = opts.sweepEvery ?? 500
  let callsSinceSweep = 0

  function sweepExpired(now: number): void {
    for (const [k, entry] of rateMap) {
      if (now - entry.windowStart > windowMs) rateMap.delete(k)
    }
  }

  function checkLocal(keyHash: string): boolean {
    const now   = Date.now()
    callsSinceSweep++
    if (callsSinceSweep >= SWEEP_EVERY) {
      callsSinceSweep = 0
      sweepExpired(now)
    }
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
    _debugMapSize(): number {
      return rateMap.size
    },
  }
}

// ── Per-IP rate limiter (audit fix: rate-limit bypass) ─────────────────────
//
// Same factory shape as createRateLimiter but with a distinct prefix so
// IP buckets never collide with per-key buckets. Limits are deliberately
// generous — high enough that no legitimate single-source workload (the
// SDK's ~30 ingest/min per active traced process, or one developer
// running tests) would ever hit them, low enough that an attacker
// rotating 1000 fake keys/sec from one IP gets capped at the IP level
// before the per-key limiter ever sees a bucket refill.
//
// Defaults: 600 req / 60s per IP. That's 10x the per-key ingest limit
// (120) and ~17x a single active traced process's natural rate (~30/min).
// A legitimate multi-tenant NAT (office network, CI runner pool) could
// plausibly hit this if many traced agents share one egress IP — if that
// becomes a real problem, raise the limit or add a per-IP+per-route
// override. The number is a starting point, not a hard contract.
export function createIpRateLimiter(opts?: Partial<{
  limit: number
  prefix: string
  windowMs: number
  sweepEvery: number
}>): RateLimiter {
  return createRateLimiter({
    limit: opts?.limit ?? 600,
    prefix: opts?.prefix ?? 'st_ip_rl',
    windowMs: opts?.windowMs ?? 60_000,
    sweepEvery: opts?.sweepEvery,
  })
}
