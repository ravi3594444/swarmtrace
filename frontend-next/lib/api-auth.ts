/**
 * Shared auth primitives: sha256 and the rate limiter (Upstash Redis in
 * production, per-isolate fallback in dev/test). Used by ingest, events and mcp.
 *
 * API keys are deliberately not cached. Each route is its own serverless
 * function, so an in-process cache can't be invalidated on revoke. The
 * key_hash lookup is an indexed point read, so hitting Supabase every time
 * is cheap. If a cache is ever needed, put it in Redis.
 */

import { isIP } from 'node:net'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Client IP extraction. On Vercel, x-forwarded-for is set by the platform so
// it can be trusted. Self-hosted, client-supplied forwarded-for headers are
// ignored; x-real-ip is used only when SWARMTRACE_TRUST_PROXY=1 (the proxy
// must overwrite it). Anything that isn't a valid IP maps to 'unknown',
// which is one shared bucket.

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

/** Test-only: expose the Vercel detection flag. */
export function _isVercel(): boolean {
  return _IS_VERCEL
}

// Rate limiter factory. Uses Upstash Redis when configured, otherwise a
// per-isolate map. Each route creates its own instance with its own prefix
// and limit. The fallback is permissive (limit x isolates), which is fine
// for abuse prevention.

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  check(keyHash: string): Promise<boolean>
  /** Test-only: size of the per-isolate fallback map. */
  _debugMapSize?(): number
}

export function createRateLimiter(opts: {
  limit: number
  prefix: string
  windowMs?: number
  /** Test-only: calls between expired-entry sweeps (default 500). */
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

  // Per-isolate fallback when Upstash env vars are absent. Expired entries
  // are swept every SWEEP_EVERY calls so the map stays bounded.
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

  // In production a missing Upstash config fails closed on the first check(),
  // so it shows up as 429s instead of silently weakening the limit. Set
  // SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1 to opt into the local map anyway.
  let missingUpstashLogged = false

  return {
    async check(keyHash: string): Promise<boolean> {
      const limiter = getUpstash()
      if (limiter) {
        const { success } = await limiter.limit(keyHash)
        return success
      }
      const allowLocal =
        process.env.NODE_ENV !== 'production' ||
        process.env.SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT === '1'
      if (!allowLocal) {
        if (!missingUpstashLogged) {
          missingUpstashLogged = true
          console.error(
            `[rate-limit] Upstash not configured in production (prefix=${prefix}). ` +
            'Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or explicitly ' +
            'set SWARMTRACE_ALLOW_LOCAL_RATE_LIMIT=1 to permit the weak per-isolate fallback.'
          )
        }
        // Fail closed; routes map false to 429.
        return false
      }
      return checkLocal(keyHash)
    },
    _debugMapSize(): number {
      return rateMap.size
    },
  }
}

// Per-IP limiter. Distinct prefix so IP buckets never collide with per-key
// ones. 600/min is well above any single-source workload (the SDK sends
// roughly 30 ingest calls/min per traced process); raise it if a shared
// NAT starts tripping it.
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

// Per-user limiter for Clerk-authed routes, keyed by userId.
// 120/min covers the pollers (traces 8s, agents/overview 30s, graph 20s)
// across several open tabs.
export function createUserRateLimiter(opts?: Partial<{
  limit: number
  prefix: string
  windowMs: number
}>): RateLimiter {
  return createRateLimiter({
    limit: opts?.limit ?? 120,
    prefix: opts?.prefix ?? 'st_user_rl',
    windowMs: opts?.windowMs ?? 60_000,
  })
}

/** Standard 429 response shape shared by all rate-limited routes. */
export function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '60',
    },
  })
}
