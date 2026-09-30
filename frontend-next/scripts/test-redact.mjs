/**
 * Tests for lib/redact.ts (TS port of swarmtrace/redact.py). Emails, API
 * keys, Luhn-valid cards and JWTs are scrubbed; trace IDs, UUIDs, hashes and
 * phone numbers pass through. Also checks validateIngest applies redaction
 * to args/output/error.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  redact,
  luhnOk,
  redactDeep,
  redactEventData,
} from '../lib/redact.ts'
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

// redactDeep: server-side scrub of /api/events data for clients that skip the SDK.
describe('redactDeep', () => {
  test('redacts strings in a flat object', () => {
    const out = redactDeep({ email: 'alice@example.com', name: 'Alice' })
    assert.equal(out.email, '[REDACTED]')
    assert.equal(out.name, 'Alice')
  })

  test('redacts strings in nested objects', () => {
    const out = redactDeep({
      data: {
        args: ['user@example.com', 'normal'],
        error: 'sk-' + 'A'.repeat(48) + ' failed',
      },
    })
    assert.equal(out.data.args[0], '[REDACTED]')
    assert.equal(out.data.args[1], 'normal')
    assert.ok(!out.data.error.includes('sk-' + 'A'.repeat(48)))
    assert.ok(out.data.error.includes('[REDACTED]'))
  })

  test('redacts strings in arrays', () => {
    const out = redactDeep(['alice@example.com', 'bob@example.com', 'plain'])
    assert.deepEqual(out, ['[REDACTED]', '[REDACTED]', 'plain'])
  })

  test('redacts API keys in deeply nested structures', () => {
    const apiKey = 'ghp_' + 'a'.repeat(36)
    const out = redactDeep({
      level1: {
        level2: {
          level3: [{ key: apiKey }],
        },
      },
    })
    assert.equal(out.level1.level2.level3[0].key, '[REDACTED]')
  })

  test('redacts JWTs in event data', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const out = redactDeep({ data: { token: jwt } })
    assert.equal(out.data.token, '[REDACTED]')
  })

  test('redacts Luhn-valid credit card numbers', () => {
    const out = redactDeep({ card: `card: ${VISA_TEST_PAN}` })
    assert.ok(!out.card.includes(VISA_TEST_PAN))
    assert.ok(out.card.includes('[REDACTED]'))
  })

  test('passes through null, undefined, numbers, booleans', () => {
    const out = redactDeep({ a: null, b: undefined, c: 42, d: true, e: false })
    assert.equal(out.a, null)
    assert.equal(out.b, undefined)
    assert.equal(out.c, 42)
    assert.equal(out.d, true)
    assert.equal(out.e, false)
  })

  test('does not redact object keys (structural metadata)', () => {
    const out = redactDeep({ email_field: 'alice@example.com' })
    assert.ok('email_field' in out)
    assert.equal(out.email_field, '[REDACTED]')
  })

  test('handles empty objects and arrays', () => {
    assert.deepEqual(redactDeep({}), {})
    assert.deepEqual(redactDeep([]), [])
  })

  test('handles mixed nested structures', () => {
    const input = {
      method: 'fill',
      args: ['#password', 'secret-value'],
      url: 'https://example.com/login?session=abc123',
      nested: { token: 'sk-' + 'B'.repeat(48) },
    }
    const out = redactDeep(input)
    // method and selector pass through (not PII).
    assert.equal(out.method, 'fill')
    assert.equal(out.args[0], '#password')
    // plain string values only go through pattern redaction, so
    // 'secret-value' survives here; the FOV redactor handles fill/type values
    assert.equal(out.args[1], 'secret-value')
    // API key in nested object IS redacted.
    assert.equal(out.nested.token, '[REDACTED]')
    assert.equal(out.url, 'https://example.com/login')
  })

  test('redacts generic secrets by structural key', () => {
    const out = redactDeep({
      password: 'CorrectHorseBatteryStaple!',
      clientSecret: 'custom-value',
      headers: { authorization: 'Basic custom-credential' },
      token_chars: 42,
    })
    assert.equal(out.password, '[REDACTED]')
    assert.equal(out.clientSecret, '[REDACTED]')
    assert.equal(out.headers.authorization, '[REDACTED]')
    assert.equal(out.token_chars, 42)
  })

  test('handles cyclic objects without overflowing', () => {
    const input = { value: 'safe' }
    input.self = input
    const out = redactDeep(input)
    assert.equal(out.value, 'safe')
    assert.equal(out.self, '[REDACTED]')
  })
})


describe('redactEventData', () => {
  test('redacts direct-client browser fill values and repeated errors', () => {
    const secret = 'CorrectHorseBatteryStaple!'
    const out = redactEventData('browser', {
      method: 'fill',
      args: ['input:nth-of-type(2)', secret],
      error: `could not submit value ${secret}`,
      url: 'https://example.com/login?session=custom-secret',
    })
    assert.deepEqual(out.args, ['input:nth-of-type(2)', '[REDACTED(len=26)]'])
    assert.ok(!out.error.includes(secret))
    assert.equal(out.url, 'https://example.com/login')
  })

  test('redacts token and accumulated fields regardless of chunk shape', () => {
    const out = redactEventData('llm_token', {
      token: 'sk-',
      accumulated: 'sk-AAAAAAAAAA',
      token_chars: 3,
      accumulated_chars: 13,
    })
    assert.equal(out.token, '[REDACTED]')
    assert.equal(out.accumulated, '[REDACTED]')
    assert.equal(out.token_chars, 3)
    assert.equal(out.accumulated_chars, 13)
  })

  test('strips goto URL arguments', () => {
    const out = redactEventData('browser', {
      method: 'goto',
      args: ['https://example.com/reset?token=custom-secret'],
    })
    assert.deepEqual(out.args, ['https://example.com/reset'])
  })
})
