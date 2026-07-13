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
  createIpRateLimiter,
  resolveClientIp,
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


// ── getClientIp (audit fix: rate-limit bypass + reviewer P2 fix) ──────────
//
// Reviewer P2 fix: the first implementation trusted x-forwarded-for
// unconditionally. On Vercel that's safe (platform overwrites it), but
// on self-hosted deployments an attacker can rotate X-Forwarded-For
// values to get a fresh rate-limit bucket per request. Now forwarded-for is
// trusted only on Vercel; self-hosted trusted-proxy mode accepts only the
// documented, proxy-overwritten x-real-ip header. All values are validated.

describe('getClientIp', () => {
  function headers(values = {}) {
    return new Headers(values)
  }

  test('self-hosted default ignores all forwarded client-IP headers', () => {
    const h = headers({
      'x-forwarded-for': '203.0.113.99',
      'x-vercel-forwarded-for': '198.51.100.20',
      'x-real-ip': '192.0.2.10',
    })
    assert.equal(resolveClientIp(h, { isVercel: false, trustProxy: false }), 'unknown')
  })

  test('self-hosted trusted proxy uses only x-real-ip', () => {
    const h = headers({
      // Attacker-controlled XFF must not override the proxy-managed value.
      'x-forwarded-for': '203.0.113.99',
      'x-real-ip': '192.0.2.10',
    })
    assert.equal(resolveClientIp(h, { isVercel: false, trustProxy: true }), '192.0.2.10')
  })

  test('self-hosted trusted proxy does not accept x-forwarded-for alone', () => {
    const h = headers({ 'x-forwarded-for': '203.0.113.99' })
    assert.equal(resolveClientIp(h, { isVercel: false, trustProxy: true }), 'unknown')
  })

  test('rejects invalid and injection-shaped x-real-ip values', () => {
    for (const value of ['not-an-ip', "1' OR '1'='1", '999.1.1.1']) {
      const h = headers({ 'x-real-ip': value })
      assert.equal(resolveClientIp(h, { isVercel: false, trustProxy: true }), 'unknown')
    }
  })

  test('accepts and normalizes IPv6 from a trusted proxy', () => {
    const h = headers({ 'x-real-ip': 'FE80::1%attacker-controlled-zone' })
    assert.equal(resolveClientIp(h, { isVercel: false, trustProxy: true }), 'fe80::1')
  })

  test('Vercel prefers its platform-specific header over XFF', () => {
    const h = headers({
      'x-vercel-forwarded-for': '192.0.2.5, 10.0.0.1',
      'x-forwarded-for': '203.0.113.9',
    })
    assert.equal(resolveClientIp(h, { isVercel: true, trustProxy: false }), '192.0.2.5')
  })

  test('Vercel falls back to its managed x-forwarded-for equivalent', () => {
    const h = headers({ 'x-forwarded-for': '198.51.100.42, 10.0.0.1' })
    assert.equal(resolveClientIp(h, { isVercel: true, trustProxy: false }), '198.51.100.42')
  })

  test('returns unknown when no valid trusted header exists', () => {
    assert.equal(
      resolveClientIp(headers(), { isVercel: true, trustProxy: false }),
      'unknown',
    )
  })
})


// ── createIpRateLimiter (audit fix: rate-limit bypass) ───────────────────
//
// The whole point of the per-IP limiter: cap an attacker who rotates fake
// API keys. Each fake key would get its own per-key bucket (defeating the
// per-key limiter), but they all share one per-IP bucket.

describe('createIpRateLimiter', () => {
  test('default limit is 600/60s (10x the per-key ingest limit)', async () => {
    // We can't read the limit back directly, but we can verify that 600
    // checks pass and the 601st fails. Use a fresh limiter with a unique
    // prefix so no other test's state interferes.
    const rl = createIpRateLimiter({ prefix: 'test-ip-default-limit' })
    const ip = '203.0.113.100'

    for (let i = 0; i < 600; i++) {
      const ok = await rl.check(ip)
      if (!ok) {
        assert.fail(`check #${i + 1} was rejected, expected 600 to pass`)
        return
      }
    }
    // 601st must fail.
    const over = await rl.check(ip)
    assert.equal(over, false, '601st check from same IP must be rate-limited')
  })

  test('caps attacker rotating 1000 fake keys from one IP', async () => {
    // The exact attack pattern from the audit finding: 1000 distinct fake
    // API keys, all from one IP. Each key gets its own per-key bucket
    // (so per-key limiting is useless), but they all share one per-IP
    // bucket.
    const rl = createIpRateLimiter({
      limit: 50,         // small for test speed
      prefix: 'test-ip-rotation-attack',
      windowMs: 60_000,
    })
    const attackerIp = '198.51.100.99'

    let allowed = 0
    for (let i = 0; i < 1000; i++) {
      // 1000 distinct fake keys — per-key limiter would let all 1000
      // through (one per bucket). Per-IP limiter must cap at 50.
      const ok = await rl.check(attackerIp)
      if (ok) allowed++
    }

    assert.equal(
      allowed, 50,
      `attacker rotating 1000 fake keys from one IP got ${allowed} ` +
        `requests through, expected per-IP cap of 50`,
    )
  })

  test('distinct IPs get distinct buckets', async () => {
    const rl = createIpRateLimiter({
      limit: 5,
      prefix: 'test-ip-distinct-buckets',
      windowMs: 60_000,
    })

    // IP A uses up its full bucket.
    for (let i = 0; i < 5; i++) {
      assert.equal(await rl.check('203.0.113.1'), true)
    }
    // IP A's 6th request must be rejected.
    assert.equal(await rl.check('203.0.113.1'), false)

    // IP B has its own fresh bucket — first request must pass.
    assert.equal(
      await rl.check('198.51.100.2'), true,
      'distinct IP must have its own bucket — per-IP limit must NOT ' +
        'be global',
    )
  })

  test('"unknown" IP (no headers) shares one bucket — safe default', async () => {
    // When the IP can't be determined, all such requests share one
    // 'unknown' bucket. This is the safe default: if each unknown-origin
    // request got a fresh bucket, the limiter would be a no-op for any
    // request that omits IP headers (which an attacker can do).
    const rl = createIpRateLimiter({
      limit: 3,
      prefix: 'test-ip-unknown-shared',
      windowMs: 60_000,
    })

    assert.equal(await rl.check('unknown'), true)
    assert.equal(await rl.check('unknown'), true)
    assert.equal(await rl.check('unknown'), true)
    assert.equal(
      await rl.check('unknown'), false,
      '4th "unknown"-origin request must be rate-limited — they share ' +
        'one bucket, not each get a fresh one',
    )
  })

  test('per-IP and per-key buckets do not collide (distinct prefixes)', async () => {
    // Both limiters use the per-isolate fallback Map (Upstash env absent
    // in tests). The map is keyed by the bucket key (IP or keyHash) with
    // the prefix baked into the limiter's internal state — wait, the
    // createRateLimiter map is keyed by just the keyHash arg, NOT by
    // prefix. So per-IP and per-key buckets with overlapping key strings
    // COULD collide.
    //
    // In practice this is fine: per-key keys are 64-char sha256 hex
    // digests, per-IP keys are IP addresses or 'unknown'. They never
    // overlap. This test locks that assumption: a per-IP check for an
    // IP-shaped string does NOT consume a per-key bucket.
    const ipLimiter = createIpRateLimiter({
      limit: 2,
      prefix: 'test-no-collision-ip',
      windowMs: 60_000,
    })
    const keyLimiter = createRateLimiter({
      limit: 2,
      prefix: 'test-no-collision-key',
      windowMs: 60_000,
    })

    // Use the IP '2' — same string would be a per-key bucket key.
    // (In production this can't happen: per-key keys are sha256 hex.)
    assert.equal(await ipLimiter.check('2'), true)
    assert.equal(await ipLimiter.check('2'), true)
    assert.equal(await ipLimiter.check('2'), false) // per-IP exhausted

    // Per-key bucket for '2' must be untouched (still has all 2 left).
    assert.equal(await keyLimiter.check('2'), true)
    assert.equal(await keyLimiter.check('2'), true)
    assert.equal(await keyLimiter.check('2'), false)
  })
})
