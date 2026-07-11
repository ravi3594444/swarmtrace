/**
 * Test: shared API auth primitives (lib/api-auth.ts).
 *
 * Covers the bug fixed in this commit: revoking an API key used to leave
 * stale entries in /api/ingest's and /api/events's per-isolate key caches
 * for up to 5 minutes, because those caches were private Maps that the
 * DELETE /api/settings/api-keys/[id] route couldn't reach. The DELETE route
 * only flipped revoked=true in Supabase.
 *
 * The fix:
 *   - The two caches are now shared singletons (ingestKeyCache, eventsKeyCache)
 *     exported from lib/api-auth.ts.
 *   - DELETE /api/settings/api-keys/[id] calls invalidateAllKeyCaches() after
 *     the PATCH, dropping every cached entry on the current isolate.
 *
 * These tests verify the cache + invalidation contract directly. The
 * integration (route-level) test would require standing up Next.js + Supabase
 * — out of scope for the node:test runner used by `npm test`. The behavior
 * under test is the unit that the bug lived in.
 *
 * Also covers:
 *   - sha256Hex (parity with the previous per-route copies)
 *   - createRateLimiter (per-isolate fallback path — Upstash env vars are
 *     unset in the test runner)
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  sha256Hex,
  createKeyCache,
  ingestKeyCache,
  eventsKeyCache,
  invalidateAllKeyCaches,
  createRateLimiter,
} from '../lib/api-auth.ts'

// ── sha256Hex ──────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  test('matches known SHA-256 of empty string', async () => {
    const out = await sha256Hex('')
    assert.equal(
      out,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  test('matches known SHA-256 of "hello"', async () => {
    const out = await sha256Hex('hello')
    assert.equal(
      out,
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  test('is deterministic and 64 hex chars', async () => {
    const a = await sha256Hex('swarmtrace-api-key-abc')
    const b = await sha256Hex('swarmtrace-api-key-abc')
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{64}$/)
  })

  test('differs across inputs (no collisions on short strings)', async () => {
    const keys = await Promise.all(
      ['key1', 'key2', 'key3', 'key4'].map(k => sha256Hex(k)),
    )
    assert.equal(new Set(keys).size, keys.length)
  })
})

// ── createKeyCache ─────────────────────────────────────────────────────────

describe('createKeyCache', () => {
  test('returns null on miss', () => {
    const c = createKeyCache()
    assert.equal(c.get('missing'), null)
  })

  test('round-trips a set then get', () => {
    const c = createKeyCache()
    c.set('hash-1', 'user-1')
    assert.equal(c.get('hash-1'), 'user-1')
  })

  test('overwrites on repeat set', () => {
    const c = createKeyCache()
    c.set('hash-1', 'user-1')
    c.set('hash-1', 'user-2')
    assert.equal(c.get('hash-1'), 'user-2')
  })

  test('invalidate drops one entry without touching others', () => {
    const c = createKeyCache()
    c.set('a', 'user-a')
    c.set('b', 'user-b')
    c.invalidate('a')
    assert.equal(c.get('a'), null)
    assert.equal(c.get('b'), 'user-b')
  })

  test('invalidateAll drops every entry', () => {
    const c = createKeyCache()
    c.set('a', 'user-a')
    c.set('b', 'user-b')
    c.set('c', 'user-c')
    assert.equal(c.size(), 3)
    c.invalidateAll()
    assert.equal(c.size(), 0)
    assert.equal(c.get('a'), null)
    assert.equal(c.get('b'), null)
    assert.equal(c.get('c'), null)
  })

  test('TTL expiry returns null (uses fake timers via short TTL)', async () => {
    // Use a 30ms TTL to keep the test fast and avoid relying on system clock skew.
    const c = createKeyCache(30)
    c.set('hash-1', 'user-1')
    assert.equal(c.get('hash-1'), 'user-1')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(c.get('hash-1'), null)
  })

  test('size() reflects live (non-expired) entries', () => {
    const c = createKeyCache()
    assert.equal(c.size(), 0)
    c.set('a', 'user-a')
    assert.equal(c.size(), 1)
    c.set('b', 'user-b')
    assert.equal(c.size(), 2)
    c.invalidate('a')
    assert.equal(c.size(), 1)
  })
})

// ── invalidateAllKeyCaches (the revocation fix) ────────────────────────────
//
// This is the contract the audit's finding #1 broke: revoking a key in
// Supabase used to leave stale entries in /api/ingest's and /api/events's
// private caches for up to 5 minutes. The DELETE route now calls
// invalidateAllKeyCaches() — these tests verify the function does what the
// route relies on.

describe('invalidateAllKeyCaches (revocation fix)', () => {
  test('clears ingestKeyCache', () => {
    ingestKeyCache.set('hash-ingest', 'user-ingest')
    assert.equal(ingestKeyCache.get('hash-ingest'), 'user-ingest')
    invalidateAllKeyCaches()
    assert.equal(ingestKeyCache.get('hash-ingest'), null)
  })

  test('clears eventsKeyCache', () => {
    eventsKeyCache.set('hash-events', 'user-events')
    assert.equal(eventsKeyCache.get('hash-events'), 'user-events')
    invalidateAllKeyCaches()
    assert.equal(eventsKeyCache.get('hash-events'), null)
  })

  test('clears BOTH caches in one call (the actual bug — DELETE must reach both)', () => {
    ingestKeyCache.set('a1', 'u1')
    eventsKeyCache.set('a2', 'u2')
    assert.equal(ingestKeyCache.get('a1'), 'u1')
    assert.equal(eventsKeyCache.get('a2'), 'u2')
    invalidateAllKeyCaches()
    assert.equal(ingestKeyCache.get('a1'), null)
    assert.equal(eventsKeyCache.get('a2'), null)
  })

  test('is idempotent — safe to call on already-empty caches', () => {
    invalidateAllKeyCaches()
    invalidateAllKeyCaches()
    invalidateAllKeyCaches()
    assert.equal(ingestKeyCache.size(), 0)
    assert.equal(eventsKeyCache.size(), 0)
  })

  test('after invalidation, new entries can be cached again (cache is reusable)', () => {
    ingestKeyCache.set('k', 'v')
    invalidateAllKeyCaches()
    ingestKeyCache.set('k', 'v2')
    assert.equal(ingestKeyCache.get('k'), 'v2')
  })
})

// ── createRateLimiter ──────────────────────────────────────────────────────

describe('createRateLimiter (per-isolate fallback path)', () => {
  test('allows first request under the limit', async () => {
    const rl = createRateLimiter({ limit: 5, prefix: 'test-1' })
    const ok = await rl.check('hash-x')
    assert.equal(ok, true)
  })

  test('blocks requests past the limit', async () => {
    const rl = createRateLimiter({ limit: 3, prefix: 'test-2' })
    assert.equal(await rl.check('hash-y'), true)
    assert.equal(await rl.check('hash-y'), true)
    assert.equal(await rl.check('hash-y'), true)
    // 4th request in the same window → blocked
    assert.equal(await rl.check('hash-y'), false)
  })

  test('different keys have independent counters (no cross-key blocking)', async () => {
    const rl = createRateLimiter({ limit: 2, prefix: 'test-3' })
    assert.equal(await rl.check('k1'), true)
    assert.equal(await rl.check('k1'), true)
    // k1 is now at limit; k2 should be unaffected
    assert.equal(await rl.check('k2'), true)
    assert.equal(await rl.check('k2'), true)
    assert.equal(await rl.check('k2'), false) // k2 hits its own limit
    assert.equal(await rl.check('k1'), false) // k1 still at limit
  })

  test('different prefixes get independent buckets (collision check)', async () => {
    // Two limiters with the same key but different prefixes should NOT
    // share state. This is what keeps /api/ingest (st_rl), /api/events
    // (st_fov_rl), and /api/mcp (st_mcp_rl) from starving each other.
    const rlA = createRateLimiter({ limit: 1, prefix: 'prefix-A' })
    const rlB = createRateLimiter({ limit: 1, prefix: 'prefix-B' })
    assert.equal(await rlA.check('shared-key'), true)
    assert.equal(await rlA.check('shared-key'), false) // A exhausted
    assert.equal(await rlB.check('shared-key'), true)  // B unaffected
  })
})
