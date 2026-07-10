/**
 * Test: PII redaction (TS port of swarmtrace/redact.py).
 *
 * Mirrors the critical cases from the Python test suite
 * (tests/test_redact.py, 48 tests). The contract is identical: emails,
 * API keys (10 prefixes), Luhn-valid credit cards, and JWTs get scrubbed;
 * non-PII (16-digit trace IDs, UUID hex, SHA-256 hashes, phone numbers)
 * passes through unredacted.
 *
 * Also verifies that validateIngest (the ingest-boundary validator) applies
 * redaction to args/output/error — the defense-in-depth fix that closes the
 * "backend trusts the SDK" PII gap flagged in the production-readiness audit.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { redact, luhnOk } from '../lib/redact.ts'
import { validateIngest } from '../lib/validate-ingest.ts'

// Issuer-published test PANs (safe to hardcode).
const VISA_TEST_PAN       = '4111111111111111'
const MASTERCARD_TEST_PAN = '5555555555554444'
const AMEX_TEST_PAN       = '378282246310005'

// Real-shaped fake JWT (header.payload.signature, base64url).
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

function mkTrace(overrides = {}) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    function: 'fn',
    args: '()',
    output: '',
    latency_sec: 0.1,
    error: null,
    timestamp: '2026-07-08T10:00:00.000Z',
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    kind: 'agent',
    ...overrides,
  }
}

// ── Luhn check ──────────────────────────────────────────────────────────────

describe('luhnOk', () => {
  test('known test PANs pass', () => {
    assert.equal(luhnOk(VISA_TEST_PAN), true)
    assert.equal(luhnOk(MASTERCARD_TEST_PAN), true)
    assert.equal(luhnOk(AMEX_TEST_PAN), true)
  })

  test('16-digit trace ID fails (the false-positive guard)', () => {
    assert.equal(luhnOk('1234567890123456'), false)
    assert.equal(luhnOk('9999999999999999'), false)
  })

  test('too short / too long rejected', () => {
    assert.equal(luhnOk('411111111111'), false)       // 12 digits
    assert.equal(luhnOk('41111111111111111111'), false) // 20 digits
  })
})

// ── Email redaction ─────────────────────────────────────────────────────────

describe('email redaction', () => {
  test('plain email scrubbed', () => {
    const out = redact('contact us at alice@example.com please')
    assert.ok(!out.includes('alice@example.com'))
    assert.ok(out.includes('[REDACTED]'))
  })

  test('subaddressed email scrubbed', () => {
    const out = redact('send to bob+reports@sub.domain.co.uk')
    assert.ok(!out.includes('bob+reports@sub.domain.co.uk'))
  })

  test('multiple emails in one string', () => {
    const out = redact('from: a@x.com, to: b@y.com')
    assert.ok(!out.includes('a@x.com'))
    assert.ok(!out.includes('b@y.com'))
    assert.equal(out.match(/\[REDACTED\]/g).length, 2)
  })
})

// ── API key redaction ───────────────────────────────────────────────────────

describe('API key redaction', () => {
  test('OpenAI sk- prefix', () => {
    const key = 'sk-' + 'A'.repeat(48)
    const out = redact(`Bearer ${key}`)
    assert.ok(!out.includes(key))
  })

  test('Anthropic sk-ant- prefix', () => {
    const key = 'sk-ant-' + 'B'.repeat(50)
    const out = redact(`x-api-key: ${key}`)
    assert.ok(!out.includes(key))
  })

  test('GitHub PAT classic', () => {
    const key = 'ghp_' + 'C'.repeat(36)
    const out = redact(`GH_TOKEN=${key}`)
    assert.ok(!out.includes(key))
  })

  test('short sk- prefix NOT redacted (length gate)', () => {
    const out = redact('just a prefix sk-abc here')
    assert.ok(out.includes('sk-abc'))
    assert.ok(!out.includes('[REDACTED]'))
  })
})

// ── JWT redaction ───────────────────────────────────────────────────────────

describe('JWT redaction', () => {
  test('JWT in bearer header', () => {
    const out = redact(`Authorization: Bearer ${FAKE_JWT}`)
    assert.ok(!out.includes(FAKE_JWT))
    assert.ok(out.includes('[REDACTED]'))
  })

  test('non-JWT eyJ passthrough', () => {
    const out = redact('just the prefix eyJfoo bar')
    assert.ok(out.includes('eyJfoo'))
  })
})

// ── Credit card redaction (Luhn-gated) ──────────────────────────────────────

describe('credit card redaction', () => {
  test('Visa 16-digit', () => {
    const out = redact(`card: ${VISA_TEST_PAN}`)
    assert.ok(!out.includes(VISA_TEST_PAN))
  })

  test('Mastercard 16-digit', () => {
    const out = redact(`pan=${MASTERCARD_TEST_PAN}`)
    assert.ok(!out.includes(MASTERCARD_TEST_PAN))
  })

  test('Amex 15-digit', () => {
    const out = redact(`amex: ${AMEX_TEST_PAN}`)
    assert.ok(!out.includes(AMEX_TEST_PAN))
  })

  test('dashed separator', () => {
    const out = redact('4111-1111-1111-1111')
    assert.ok(!out.includes('4111'))
  })
})

// ── Non-PII pass-through (the false-positive guard) ─────────────────────────

describe('non-PII pass-through', () => {
  test('16-digit trace ID passes through', () => {
    const id = '1234567890123456'
    assert.equal(redact(id), id)
    assert.equal(redact(`trace=${id}`), `trace=${id}`)
  })

  test('UUID hex passes through', () => {
    const id = '0123456789abcdef0123456789abcdef'
    assert.equal(redact(id), id)
  })

  test('SHA-256 hash passes through', () => {
    const h = 'e'.repeat(64)
    assert.equal(redact(h), h)
  })

  test('short numeric ID passes through', () => {
    assert.equal(redact('order #1234567'), 'order #1234567')
  })

  test('phone number NOT redacted (out of scope)', () => {
    assert.equal(redact('call 555-123-4567'), 'call 555-123-4567')
  })

  test('plain text unchanged', () => {
    const msg = 'the agent ran successfully and returned 5 results'
    assert.equal(redact(msg), msg)
  })
})

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('null passes through', () => {
    assert.equal(redact(null), null)
  })

  test('undefined passes through', () => {
    assert.equal(redact(undefined), null)
  })

  test('empty string passes through', () => {
    assert.equal(redact(''), '')
  })

  test('idempotent', () => {
    const once = redact('email is alice@example.com and key is sk-' + 'A'.repeat(48))
    const twice = redact(once)
    assert.equal(once, twice)
  })

  test('mixed PII in one string', () => {
    const s = `contact: alice@example.com | key: sk-${'A'.repeat(48)} | card: ${VISA_TEST_PAN} | jwt: ${FAKE_JWT}`
    const out = redact(s)
    assert.ok(!out.includes('alice@example.com'))
    assert.ok(!out.includes('sk-' + 'A'.repeat(48)))
    assert.ok(!out.includes(VISA_TEST_PAN))
    assert.ok(!out.includes(FAKE_JWT))
    assert.equal(out.match(/\[REDACTED\]/g).length, 4)
  })
})

// ── validateIngest applies redaction (defense-in-depth) ─────────────────────

describe('validateIngest applies redaction at ingest boundary', () => {
  test('email in args is scrubbed before reaching the DB', () => {
    const { rows, error } = validateIngest(mkTrace({
      args: "('alice@example.com', 'please help')",
    }))
    assert.equal(error, undefined)
    assert.ok(!rows[0].args.includes('alice@example.com'))
    assert.ok(rows[0].args.includes('[REDACTED]'))
    assert.ok(rows[0].args.includes('please help'))  // non-PII preserved
  })

  test('API key in error is scrubbed', () => {
    const fakeKey = 'sk-ant-' + 'X'.repeat(50)
    const { rows } = validateIngest(mkTrace({
      error: `AuthenticationError: invalid api key '${fakeKey}' (status 401)`,
    }))
    assert.ok(!rows[0].error.includes(fakeKey))
    assert.ok(rows[0].error.includes('[REDACTED]'))
    assert.ok(rows[0].error.includes('AuthenticationError'))
  })

  test('credit card in output is scrubbed', () => {
    const { rows } = validateIngest(mkTrace({
      output: `Your card ending in 1111 was charged. Full PAN: ${VISA_TEST_PAN}`,
    }))
    assert.ok(!rows[0].output.includes(VISA_TEST_PAN))
    assert.ok(rows[0].output.includes('ending in 1111'))
  })

  test('JWT in output is scrubbed', () => {
    const { rows } = validateIngest(mkTrace({
      output: `session token: ${FAKE_JWT}`,
    }))
    assert.ok(!rows[0].output.includes(FAKE_JWT))
  })

  test('16-digit trace ID in args passes through (no false positive)', () => {
    const traceId = '1234567890123456'
    const { rows } = validateIngest(mkTrace({
      args: `trace=${traceId}`,
    }))
    assert.equal(rows[0].args, `trace=${traceId}`)
  })

  test('redaction applies to every trace in a batch', () => {
    const payload = {
      traces: [
        mkTrace({ id: 't1', args: 'alice@example.com' }),
        mkTrace({ id: 't2', error: 'sk-' + 'A'.repeat(48) + ' failed' }),
        mkTrace({ id: 't3', output: `card: ${VISA_TEST_PAN}` }),
      ],
    }
    const { rows, error } = validateIngest(payload)
    assert.equal(error, undefined)
    assert.ok(!rows[0].args.includes('alice@example.com'))
    assert.ok(!rows[1].error.includes('sk-' + 'A'.repeat(48)))
    assert.ok(!rows[2].output.includes(VISA_TEST_PAN))
  })
})
