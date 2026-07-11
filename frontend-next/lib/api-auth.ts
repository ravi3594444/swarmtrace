/**
 * Shared API authentication primitives — sha256, per-isolate key cache,
 * rate limiter (Upstash Redis with per-isolate fallback).
 *
 * Used by /api/ingest, /api/events, and /api/mcp so they don't each
 * re-implement (and drift on) the same logic. The shared key caches
 * (ingestKeyCache, eventsKeyCache) are also reachable from
 * /api/settings/api-keys/[id] via invalidateAllKeyCaches(), which is
 * the fix for the "revoked key still works for up to 5 min" bug:
 * the DELETE route used to flip revoked=true in Supabase but never
 * touched these caches, so any warm isolate that had already cached
 * the key kept accepting it until the TTL expired.
 *
 * NOTE: This is still per-isolate caching. On Vercel, other warm
 * isolates will continue to serve a revoked key until their copy of
 * the cache expires (up to CACHE_TTL_MS = 5 min). To eliminate that
 * window entirely, deploy Upstash Redis (already supported by the
 * rate limiter below) and store key lookups there too. For now, the
 * 5-min worst-case on other isolates is documented and accepted —
 * same as before, but the in-isolate case is now immediate.
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

// ── Per-isolate key cache ──────────────────────────────────────────────────
// Vercel serverless isolates are not shared — this Map lives per-isolate.
// It still helps: repeated requests within the same warm isolate skip the
// DB lookup. For a true shared cache, use Vercel KV or Upstash Redis.

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry { user_id: string; expires: number }

export interface KeyCache {
  /** Returns the cached user_id for this hash, or null if absent / expired. */
  get(hash: string): string | null
  /** Cache a key_hash → user_id mapping with the configured TTL. */
  set(hash: string, user_id: string): void
  /** Drop one entry (e.g. after a targeted revoke). */
  invalidate(hash: string): void
  /** Drop every entry (called by DELETE /api/settings/api-keys/[id]). */
  invalidateAll(): void
  /** Number of live entries — for tests / observability. */
  size(): number
}

export function createKeyCache(ttlMs: number = DEFAULT_CACHE_TTL_MS): KeyCache {
  const map = new Map<string, CacheEntry>()
  return {
    get(hash: string): string | null {
      const entry = map.get(hash)
      if (!entry) return null
      if (Date.now() > entry.expires) { map.delete(hash); return null }
      return entry.user_id
    },
    set(hash: string, user_id: string): void {
      map.set(hash, { user_id, expires: Date.now() + ttlMs })
    },
    invalidate(hash: string): void {
      map.delete(hash)
    },
    invalidateAll(): void {
      map.clear()
    },
    size(): number {
      return map.size
    },
  }
}

// Singleton caches shared by all routes in the same isolate.
// Each route used to keep its own copy — that's how the revocation bug
// crept in: the DELETE route couldn't reach them. Now it can, via
// invalidateAllKeyCaches().
const _ingestKeyCache = createKeyCache()
const _eventsKeyCache = createKeyCache()

export const ingestKeyCache: KeyCache = _ingestKeyCache
export const eventsKeyCache: KeyCache = _eventsKeyCache

/**
 * Drop every cached API-key lookup in every per-isolate cache. Called by
 * DELETE /api/settings/api-keys/[id] after flipping revoked=true in Supabase.
 *
 * Effect on THIS isolate: the next /api/ingest or /api/events request
 * re-checks Supabase and rejects the revoked key immediately.
 *
 * Effect on OTHER warm isolates: none — they keep their own copy until
 * TTL expiry. See file-level note about Upstash Redis for a true fix.
 */
export function invalidateAllKeyCaches(): void {
  _ingestKeyCache.invalidateAll()
  _eventsKeyCache.invalidateAll()
}

// ── Rate limiter factory ───────────────────────────────────────────────────
// Distributed (Upstash Redis) when env configured; per-isolate fallback
// otherwise. Each route creates its own instance with its own prefix
// (so buckets don't collide) and its own limit (ingest/mcp: 120, events: 500).

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
