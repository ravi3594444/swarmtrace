/**
 * Test: shared API auth primitives (lib/api-auth.ts).
 *
 * Covers sha256Hex and createRateLimiter (per-isolate fallback path).
 *
 * History: this file previously also tested createKeyCache +
 * invalidateAllKeyCaches (the per-isolate key cache that was supposed to
 * fix audit finding #1 — revoked keys still working for up to 5 min).
 * Those tests passed in node:test but the fix was a no-op in production:
 * Vercel compiles each /api route as a separate serverless function with
 * its own memory, so invalidateAllKeyCaches() in the DELETE function
 * couldn't reach the ingest/events function's cache. The cache was
 * removed entirely (see lib/api-auth.ts history note), and the cache
 * tests went with it. The sha256 + rate-limiter tests below cover what
 * remains in the module.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  sha256Hex,
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

// ── bounded memory (audit finding #7) ───────────────────────────────────────

describe('createRateLimiter fallback map memory bound (finding #7)', () => {
  test('expired entries are swept, not kept forever', async () => {
    // Tiny window + tiny sweepEvery so a sweep is forced almost
    // immediately instead of needing 500 real calls.
    const rl = createRateLimiter({
      limit: 100,
      prefix: 'test-leak-1',
      windowMs: 10,
      sweepEvery: 3,
    })

    // Hit 3 distinct keys — their windows expire almost immediately.
    await rl.check('leak-a')
    await rl.check('leak-b')
    await rl.check('leak-c')
    assert.equal(rl._debugMapSize(), 3, 'all 3 keys tracked before expiry')

    // Wait past the 10ms window, then make ONE more call. That call both
    // crosses the sweepEvery=3 threshold and finds all prior entries
    // expired — they should be swept away, not accumulate forever.
    await new Promise(r => setTimeout(r, 20))
    await rl.check('leak-d') // triggers the sweep (4th call, sweepEvery=3)
    await rl.check('leak-e')
    await rl.check('leak-f') // triggers another sweep

    // Bounded: only the keys still inside their (already-expired-by-now)
    // window survive a sweep, so the map never grows past what's
    // "currently live" — it must NOT be 6 (one entry per key ever seen).
    assert.ok(
      rl._debugMapSize() < 6,
      `map grew unboundedly: size=${rl._debugMapSize()}, expected old ` +
        `entries to have been swept`,
    )
  })

  test('many distinct short-lived keys do not accumulate without bound', async () => {
    const rl = createRateLimiter({
      limit: 1000,
      prefix: 'test-leak-2',
      windowMs: 5,
      sweepEvery: 10,
    })

    // Simulate 50 distinct API keys checking in, in bursts, with the
    // window expiring between bursts — the historical bug pattern for a
    // long-lived isolate serving many different callers over time.
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 10; i++) {
        await rl.check(`burst-${batch}-${i}`)
      }
      await new Promise(r => setTimeout(r, 10)) // let the window expire
    }

    // 50 distinct keys were checked total, but thanks to periodic
    // sweeping the map should never have been allowed to hold anywhere
    // near all 50 stale entries at once by the end.
    assert.ok(
      rl._debugMapSize() <= 10,
      `map size=${rl._debugMapSize()} — expired entries from earlier ` +
        `bursts were not being swept`,
    )
  })
})
