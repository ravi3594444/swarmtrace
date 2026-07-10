/**
 * Test: RLS enforcement decision logic (lib/supabase.ts → decideRlsMode).
 *
 * Tests the pure decision function extracted from supaUserRequest. This is
 * the core of the fail-closed fix: in production, if RLS cannot be enforced
 * (no Clerk token, or anon key missing), the function returns 'fail-closed'
 * instead of silently falling back to the service-role key.
 *
 * The OLD behavior (silent fallback in all environments) was flagged as HIGH
 * severity in the production-readiness audit: an operator could misconfigure
 * the Clerk↔Supabase integration and never realize RLS was being bypassed,
 * because the only signal was a console.warn in the Vercel logs.
 *
 * The NEW behavior:
 *   - Production (NODE_ENV=production, SUPABASE_RLS_FALLBACK unset): FAIL CLOSED.
 *     supaUserRequest throws RlsEnforcementError, route returns 401.
 *   - Development (NODE_ENV !== production): FALLBACK (keep local dev working).
 *   - SUPABASE_RLS_FALLBACK=1 in any env: FALLBACK (explicit escape hatch).
 *
 * Also tests the health-check module (lib/health-check.ts) that surfaces
 * misconfigured env vars at startup.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { decideRlsMode, RlsEnforcementError } from '../lib/supabase.ts'
import { runHealthCheck } from '../lib/health-check.ts'

// ── decideRlsMode ───────────────────────────────────────────────────────────

describe('decideRlsMode', () => {
  // Happy path: token + anon key → RLS enforced, in any environment.
  test('returns rls mode when token + anonKey present (production)', () => {
    const decision = decideRlsMode({
      token: 'fake-jwt',
      anonKey: 'fake-anon-key',
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'rls')
    assert.equal(decision.anonKey, 'fake-anon-key')
  })

  test('returns rls mode when token + anonKey present (development)', () => {
    const decision = decideRlsMode({
      token: 'fake-jwt',
      anonKey: 'fake-anon-key',
      fallbackEnabled: true,
    })
    assert.equal(decision.mode, 'rls')
  })

  // Production fail-closed: no token → throw, not fallback.
  test('returns fail-closed in production when token missing', () => {
    const decision = decideRlsMode({
      token: null,
      tokenFailureReason: 'Clerk getToken() returned null',
      anonKey: 'fake-anon-key',
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'fail-closed')
    assert.match(decision.reason, /Clerk getToken\(\) returned null/)
  })

  test('returns fail-closed in production when anonKey missing', () => {
    const decision = decideRlsMode({
      token: 'fake-jwt',
      anonKey: undefined,
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'fail-closed')
    assert.match(decision.reason, /NEXT_PUBLIC_SUPABASE_ANON_KEY missing/)
  })

  test('returns fail-closed in production when both missing', () => {
    const decision = decideRlsMode({
      token: null,
      anonKey: undefined,
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'fail-closed')
    // Reports the token reason first (checked before anonKey).
    assert.match(decision.reason, /Clerk token unavailable/)
  })

  // Development fallback: no token → fallback (local dev ergonomics).
  test('returns fallback in development when token missing', () => {
    const decision = decideRlsMode({
      token: null,
      tokenFailureReason: 'Clerk getToken() returned null',
      anonKey: 'fake-anon-key',
      fallbackEnabled: true,
    })
    assert.equal(decision.mode, 'fallback')
    assert.match(decision.reason, /Clerk getToken\(\) returned null/)
  })

  test('returns fallback in development when anonKey missing', () => {
    const decision = decideRlsMode({
      token: 'fake-jwt',
      anonKey: undefined,
      fallbackEnabled: true,
    })
    assert.equal(decision.mode, 'fallback')
    assert.match(decision.reason, /NEXT_PUBLIC_SUPABASE_ANON_KEY missing/)
  })

  // Escape hatch: SUPABASE_RLS_FALLBACK=1 in production → fallback.
  test('returns fallback in production when SUPABASE_RLS_FALLBACK=1 (escape hatch)', () => {
    const decision = decideRlsMode({
      token: null,
      anonKey: 'fake-anon-key',
      fallbackEnabled: true,  // SUPABASE_RLS_FALLBACK=1 forces this
    })
    assert.equal(decision.mode, 'fallback')
  })

  // Token failure reason defaults to a generic message if not provided.
  test('uses generic reason when tokenFailureReason not provided', () => {
    const decision = decideRlsMode({
      token: null,
      anonKey: 'fake-anon-key',
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'fail-closed')
    assert.match(decision.reason, /Clerk token unavailable/)
  })

  // Auth() threw: the reason should propagate.
  test('propagates auth() threw reason', () => {
    const decision = decideRlsMode({
      token: null,
      tokenFailureReason: 'auth() threw: Clerk context not hydrated',
      anonKey: 'fake-anon-key',
      fallbackEnabled: false,
    })
    assert.equal(decision.mode, 'fail-closed')
    assert.match(decision.reason, /auth\(\) threw: Clerk context not hydrated/)
  })
})

// ── RlsEnforcementError ─────────────────────────────────────────────────────

describe('RlsEnforcementError', () => {
  test('is an Error subclass with the right name', () => {
    const err = new RlsEnforcementError('test reason')
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'RlsEnforcementError')
    assert.match(err.message, /test reason/)
    assert.match(err.message, /SUPABASE_RLS_FALLBACK=1/)
  })

  test('routes can instanceof-check it', () => {
    const err = new RlsEnforcementError('test')
    assert.ok(err instanceof RlsEnforcementError)
    // A generic Error should NOT match — routes rely on this distinction
    // to return 401 (RLS failure) vs 500 (other errors).
    const generic = new Error('other')
    assert.ok(!(generic instanceof RlsEnforcementError))
  })
})

// ── runHealthCheck ──────────────────────────────────────────────────────────

describe('runHealthCheck', () => {
  test('returns ok when all required env vars present', () => {
    // health-check reads process.env at call time — save/restore.
    const saved = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'https://x.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'svc-key'
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x'
      process.env.CLERK_SECRET_KEY = 'sk_test_x'
      process.env.NODE_ENV = 'development'

      const result = runHealthCheck()
      assert.equal(result.ok, true)
      assert.equal(result.missing.length, 0)
    } finally {
      process.env = saved
    }
  })

  test('reports missing required Supabase env vars', () => {
    const saved = { ...process.env }
    try {
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_KEY
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      process.env.NODE_ENV = 'development'

      const result = runHealthCheck()
      assert.equal(result.ok, false)
      assert.ok(result.missing.includes('SUPABASE_URL'))
      assert.ok(result.missing.includes('SUPABASE_SERVICE_KEY'))
      assert.ok(result.missing.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
    } finally {
      process.env = saved
    }
  })

  test('warns loudly when anon key missing in production', () => {
    const saved = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'https://x.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'svc-key'
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      process.env.NODE_ENV = 'production'

      const result = runHealthCheck()
      const anonWarning = result.warnings.find(w => w.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY') && w.includes('production'))
      assert.ok(anonWarning, 'should warn about missing anon key in production')
      assert.match(anonWarning, /RlsEnforcementError/)
    } finally {
      process.env = saved
    }
  })

  test('warns when SUPABASE_RLS_FALLBACK=1 in production', () => {
    const saved = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'https://x.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'svc-key'
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
      process.env.SUPABASE_RLS_FALLBACK = '1'
      process.env.NODE_ENV = 'production'

      const result = runHealthCheck()
      const fallbackWarning = result.warnings.find(w => w.includes('SUPABASE_RLS_FALLBACK=1'))
      assert.ok(fallbackWarning, 'should warn about fallback in production')
      assert.match(fallbackWarning, /emergency escape hatch/)
    } finally {
      process.env = saved
    }
  })

  test('does NOT warn about fallback in development', () => {
    const saved = { ...process.env }
    try {
      process.env.SUPABASE_URL = 'https://x.supabase.co'
      process.env.SUPABASE_SERVICE_KEY = 'svc-key'
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
      process.env.NODE_ENV = 'development'
      delete process.env.SUPABASE_RLS_FALLBACK

      const result = runHealthCheck()
      const fallbackWarning = result.warnings.find(w => w.includes('SUPABASE_RLS_FALLBACK'))
      assert.equal(fallbackWarning, undefined, 'should not warn about fallback in dev')
    } finally {
      process.env = saved
    }
  })
})
