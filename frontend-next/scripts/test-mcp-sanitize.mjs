/**
 * Test: lib/sanitize-mcp-trace.ts — the MCP record_trace boundary
 * sanitization (audit pass 2, finding 1).
 *
 * Before this module, the MCP route passed args/output/error/attributes
 * straight into `upsert_trace_for_key`. The ingest and events routes both
 * redact at the boundary; the MCP route is the one path where non-SDK
 * clients (Hermes, Claude Desktop, Cursor) — which never run the Python
 * SDK's client-side redaction — could land PII/API keys in the database,
 * and attributes had no size cap (ingest caps at 64 KB).
 *
 * Covers:
 *   1. PII redaction of args/output/error (emails, API keys, JWTs, cards).
 *   2. Truncation to MAX_TEXT_LEN (before redaction, same order as ingest).
 *   3. Optional fields: undefined/null args/output/error normalize safely.
 *   4. attributes: plain-object validation + 64 KB JSON cap; invalid
 *      attributes reject with a message (the route turns that into isError).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeMcpTraceFields } from '../lib/sanitize-mcp-trace.ts'
import { MAX_TEXT_LEN, MAX_ATTRIBUTES_SIZE } from '../lib/validate-ingest.ts'

describe('sanitizeMcpTraceFields — text fields', () => {
  test('redacts emails, API keys, JWTs, and card numbers from args/output/error', () => {
    const { ok, value } = sanitizeMcpTraceFields({
      args: 'tool call with admin@example.com and sk-abcdefghijklmnopqrstuvwxyz123456',
      output: 'result with card 4111 1111 1111 1111',
      error: 'failed for user@example.com',
    })
    assert.equal(ok, true)
    assert.equal(value.args.includes('admin@example.com'), false)
    assert.equal(value.args.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false)
    assert.equal(value.args.includes('[REDACTED]'), true)
    assert.equal(value.output.includes('4111 1111 1111 1111'), false)
    assert.equal(value.output.includes('[REDACTED]'), true)
    assert.equal(value.error.includes('user@example.com'), false)
    assert.equal(value.error.includes('[REDACTED]'), true)
  })

  test('truncates long text to MAX_TEXT_LEN before redacting', () => {
    const long = 'x'.repeat(MAX_TEXT_LEN + 500)
    const { value } = sanitizeMcpTraceFields({ args: long, output: long })
    assert.equal(value.args.length, MAX_TEXT_LEN)
    assert.equal(value.output.length, MAX_TEXT_LEN)
  })

  test('normalizes undefined/null/absent fields safely', () => {
    const { value } = sanitizeMcpTraceFields({})
    assert.equal(value.args, '')
    assert.equal(value.output, '')
    assert.equal(value.error, null)
    assert.equal(value.attributes, null)
  })

  test('non-string error becomes null, non-string args become empty', () => {
    const { value } = sanitizeMcpTraceFields({ args: 42, error: 7 })
    assert.equal(value.args, '')
    assert.equal(value.error, null)
  })
})

describe('sanitizeMcpTraceFields — attributes', () => {
  test('passes through a plain object', () => {
    const attrs = { provider: 'mcp', tool_name: 'scrape', status_code: 200 }
    const { ok, value } = sanitizeMcpTraceFields({ attributes: attrs })
    assert.equal(ok, true)
    assert.deepEqual(value.attributes, attrs)
  })

  test('rejects arrays and primitives', () => {
    for (const bad of [[1, 2], 'str', 42, true]) {
      const { ok, error } = sanitizeMcpTraceFields({ attributes: bad })
      assert.equal(ok, false)
      assert.match(error, /attributes must be a JSON object/)
    }
  })

  test('rejects attributes over the 64 KB cap (mirrors ingest)', () => {
    const huge = { blob: 'a'.repeat(MAX_ATTRIBUTES_SIZE + 1) }
    const { ok, error } = sanitizeMcpTraceFields({ attributes: huge })
    assert.equal(ok, false)
    assert.match(error, /exceeds/)
  })

  test('accepts attributes right at the cap', () => {
    // The cap applies to the JSON-serialized size, so compute the exact
    // content length that lands the serialized form on the boundary.
    const atCap = { blob: 'a'.repeat(MAX_ATTRIBUTES_SIZE - JSON.stringify({ blob: '' }).length) }
    assert.equal(JSON.stringify(atCap).length, MAX_ATTRIBUTES_SIZE)
    const { ok } = sanitizeMcpTraceFields({ attributes: atCap })
    assert.equal(ok, true)
  })

  test('null/undefined attributes are allowed (stored as null)', () => {
    assert.equal(sanitizeMcpTraceFields({ attributes: null }).value.attributes, null)
    assert.equal(sanitizeMcpTraceFields({}).value.attributes, null)
  })
})
