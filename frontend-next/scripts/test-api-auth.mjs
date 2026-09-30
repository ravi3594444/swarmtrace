/**
 * Tests for lib/api-auth.ts: sha256Hex, createRateLimiter (per-isolate
 * fallback), getClientIp and the per-IP limiter.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  sha256Hex,
  createRateLimiter,
  createIpRateLimiter,
  resolveClientIp,
} from '../lib/api-auth.ts'

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
    // 4th request in the same window is blocked
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
    // same key, different prefixes: no shared state
    const rlA = createRateLimiter({ limit: 1, prefix: 'prefix-A' })
    const rlB = createRateLimiter({ limit: 1, prefix: 'prefix-B' })
    assert.equal(await rlA.check('shared-key'), true)
    assert.equal(await rlA.check('shared-key'), false) // A exhausted
    assert.equal(await rlB.check('shared-key'), true)  // B unaffected
  })
})

describe('createRateLimiter fallback map memory bound', () => {
  test('expired entries are swept, not kept forever', async () => {
    // tiny window and sweepEvery so a sweep happens quickly
    const rl = createRateLimiter({
      limit: 100,
      prefix: 'test-leak-1',
      windowMs: 10,
      sweepEvery: 3,
    })

    // 3 distinct keys, windows expire almost immediately
    await rl.check('leak-a')
    await rl.check('leak-b')
    await rl.check('leak-c')
    assert.equal(rl._debugMapSize(), 3, 'all 3 keys tracked before expiry')

    // wait past the 10ms window; the next call crosses sweepEvery and sweeps
    await new Promise(r => setTimeout(r, 20))
    await rl.check('leak-d') // triggers the sweep (4th call, sweepEvery=3)
    await rl.check('leak-e')
    await rl.check('leak-f') // triggers another sweep

    // survivors must be fewer than 6 (one per key ever seen)
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

    // 50 distinct keys in bursts, with the window expiring between bursts
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 10; i++) {
        await rl.check(`burst-${batch}-${i}`)
      }
      await new Promise(r => setTimeout(r, 10)) // let the window expire
    }

    // 50 keys were checked in total, the map should never hold most of them
    assert.ok(
      rl._debugMapSize() <= 10,
      `map size=${rl._debugMapSize()} — expired entries from earlier ` +
        `bursts were not being swept`,
    )
  })
})


// getClientIp: forwarded-for headers are trusted only on Vercel. Self-hosted
// with a trusted proxy only x-real-ip is used, and all values are validated.

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


// createIpRateLimiter: caps an attacker rotating fake API keys, who would
// otherwise get a fresh per-key bucket each time.

describe('createIpRateLimiter', () => {
  test('default limit is 600/60s', async () => {
    // 600 checks pass and the 601st fails; unique prefix avoids state from other tests
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

  test('caps an attacker rotating 1000 fake keys from one IP', async () => {
    // 1000 distinct fake keys get a bucket each, but share one per-IP bucket
    const rl = createIpRateLimiter({
      limit: 50,         // small for test speed
      prefix: 'test-ip-rotation-attack',
      windowMs: 60_000,
    })
    const attackerIp = '198.51.100.99'

    let allowed = 0
    for (let i = 0; i < 1000; i++) {
      // per-key limiting would let all 1000 through, per-IP caps at 50
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

    // IP B has its own fresh bucket
    assert.equal(
      await rl.check('198.51.100.2'), true,
      'distinct IP must have its own bucket — per-IP limit must NOT ' +
        'be global',
    )
  })

  test('"unknown" IP (no headers) shares one bucket', async () => {
    // unknown-origin requests share one bucket; a fresh bucket each would
    // make the limiter a no-op for requests that omit IP headers
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
    // The fallback map is keyed only by the key string, but per-key keys are
    // sha256 hex and per-IP keys are IPs or 'unknown', so they don't overlap.
    // This checks an IP-shaped key doesn't consume a per-key bucket.
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

    // the IP '2' would also be a valid per-key bucket key
    assert.equal(await ipLimiter.check('2'), true)
    assert.equal(await ipLimiter.check('2'), true)
    assert.equal(await ipLimiter.check('2'), false) // per-IP exhausted

    // the per-key bucket for '2' is untouched
    assert.equal(await keyLimiter.check('2'), true)
    assert.equal(await keyLimiter.check('2'), true)
    assert.equal(await keyLimiter.check('2'), false)
  })
})
