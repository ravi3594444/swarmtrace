/**
 * Tests for ingest validation (lib/validate-ingest.ts): single-object
 * (legacy) and batch `{ traces: [...] }` payloads, batch rejection on any
 * bad trace, session_id preservation, and gzip decoding. The route itself
 * only adds auth, rate limiting and the RPC loop, so it isn't covered here.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { gzipSync } from 'node:zlib'

import {
  validateTrace,
  normalizeIngestPayload,
  validateIngest,
  decodeIngestBody,
  MAX_DECOMPRESSED_BYTES,
} from '../lib/validate-ingest.ts'

function mkTrace(overrides = {}) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    function: 'my_agent',
    args: '()',
    output: '',
    latency_sec: 0.1,
    error: null,
    timestamp: '2026-07-08T10:00:00.000Z',
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    kind: 'agent',
    agent_id: undefined,
    agent_name: undefined,
    session_id: undefined,
    ...overrides,
  }
}

describe('validateTrace: single trace object', () => {
  test('accepts a well-formed trace and normalizes optional fields', () => {
    const { row, error } = validateTrace(mkTrace({ id: 'abc', function: 'fn' }))
    assert.equal(error, undefined)
    assert.equal(row.id, 'abc')
    assert.equal(row.function, 'fn')
    // Defaults: kind=agent, agent_id=id, agent_name=function, session_id=null
    assert.equal(row.kind, 'agent')
    assert.equal(row.agent_id, 'abc')
    assert.equal(row.agent_name, 'fn')
    assert.equal(row.session_id, null)
  })

  test('preserves session_id when provided', () => {
    const { row } = validateTrace(mkTrace({ session_id: 'thread-42' }))
    assert.equal(row.session_id, 'thread-42')
  })

  test('rejects missing id', () => {
    const { error } = validateTrace(mkTrace({ id: undefined }))
    assert.match(error, /id must be a non-empty string/)
  })

  test('rejects non-object payload', () => {
    assert.match(validateTrace(null).error, /Body must be a JSON object/)
    assert.match(validateTrace('hello').error, /Body must be a JSON object/)
    assert.match(validateTrace([1, 2]).error, /Body must be a JSON object/)
  })
})

describe('normalizeIngestPayload: shape detection', () => {
  test('single-object shape wraps into a one-element array', () => {
    const single = mkTrace({ id: 's1' })
    const traces = normalizeIngestPayload(single)
    assert.equal(traces.length, 1)
    assert.equal(traces[0].id, 's1')
  })

  test('batch shape returns the array as-is', () => {
    const batch = { traces: [mkTrace({ id: 'b1' }), mkTrace({ id: 'b2' })] }
    const traces = normalizeIngestPayload(batch)
    assert.equal(traces.length, 2)
    assert.equal(traces[0].id, 'b1')
    assert.equal(traces[1].id, 'b2')
  })

  test('empty batch is rejected (returns null)', () => {
    assert.equal(normalizeIngestPayload({ traces: [] }), null)
  })

  test('non-object body is rejected', () => {
    assert.equal(normalizeIngestPayload(null), null)
    assert.equal(normalizeIngestPayload('hello'), null)
    assert.equal(normalizeIngestPayload([1, 2, 3]), null)
    assert.equal(normalizeIngestPayload(42), null)
  })
})

describe('validateIngest: end-to-end both shapes', () => {
  test('single-object payload produces one valid row', () => {
    const payload = mkTrace({
      id: 'single-1',
      function: 'agent_a',
      session_id: 'session-x',
    })
    const { rows, error } = validateIngest(payload)
    assert.equal(error, undefined)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'single-1')
    assert.equal(rows[0].session_id, 'session-x')
  })

  test('batch payload produces N rows in order', () => {
    const payload = {
      traces: [
        mkTrace({ id: 'batch-1', function: 'agent_a', session_id: 'sess-1' }),
        mkTrace({ id: 'batch-2', function: 'agent_b', session_id: 'sess-1' }),
        mkTrace({ id: 'batch-3', function: 'agent_c', session_id: 'sess-2' }),
      ],
    }
    const { rows, error } = validateIngest(payload)
    assert.equal(error, undefined)
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map(r => r.id),
      ['batch-1', 'batch-2', 'batch-3'],
    )
    // the thread view relies on session_id landing in the DB as sent
    assert.equal(rows[0].session_id, 'sess-1')
    assert.equal(rows[1].session_id, 'sess-1')
    assert.equal(rows[2].session_id, 'sess-2')
  })

  test('batch with one bad trace rejects the WHOLE batch', () => {
    const payload = {
      traces: [
        mkTrace({ id: 'good-1' }),
        mkTrace({ id: '', function: 'bad' }), // missing id
        mkTrace({ id: 'good-2' }),
      ],
    }
    const { rows, error } = validateIngest(payload)
    // no partial accept; the SDK retries the whole batch
    assert.equal(rows, undefined)
    assert.ok(error)
    assert.match(error.error, /id must be a non-empty string/)
    // index says which trace was bad (0-based)
    assert.equal(error.index, 1)
  })

  test('empty batch is rejected', () => {
    const { rows, error } = validateIngest({ traces: [] })
    assert.equal(rows, undefined)
    assert.match(error.error, /single trace object or \{ traces/)
  })

  test('non-object body is rejected', () => {
    const { rows, error } = validateIngest('not an object')
    assert.equal(rows, undefined)
    assert.match(error.error, /single trace object or \{ traces/)
  })

  test('array at top level is rejected (must be wrapped in { traces: [...] })', () => {
    // a bare array isn't a valid payload; it must be wrapped in { traces: [...] }
    const { rows, error } = validateIngest([mkTrace({ id: 'x' })])
    assert.equal(rows, undefined)
    assert.match(error.error, /single trace object or \{ traces/)
  })

  test('large batch validates every trace (no silent truncation)', () => {
    // 20 traces, the SDK's batch-size trigger
    const payload = {
      traces: Array.from({ length: 20 }, (_, i) =>
        mkTrace({ id: `trace-${i}`, function: `agent_${i}` }),
      ),
    }
    const { rows, error } = validateIngest(payload)
    assert.equal(error, undefined)
    assert.equal(rows.length, 20)
    assert.equal(rows[0].id, 'trace-0')
    assert.equal(rows[19].id, 'trace-19')
  })
})

describe('decodeIngestBody: gzip round-trip (SDK batch wire format)', () => {
  // matches what the SDK's _send_batch_remote sends: gzip(JSON({"traces": [...]}))
  const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

  test('gzipped batch body decodes and validates end-to-end', async () => {
    const payload = { traces: [mkTrace({ id: 'gz-1' }), mkTrace({ id: 'gz-2' })] }
    const wire = toArrayBuffer(gzipSync(Buffer.from(JSON.stringify(payload))))
    const decoded = JSON.parse(await decodeIngestBody(wire, 'gzip'))
    const { rows, error } = validateIngest(decoded)
    assert.equal(error, undefined)
    assert.deepEqual(rows.map(r => r.id), ['gz-1', 'gz-2'])
  })

  test('plain (non-gzip) body still decodes when Content-Encoding is absent', async () => {
    const payload = mkTrace({ id: 'plain-1' })
    const wire = toArrayBuffer(Buffer.from(JSON.stringify(payload)))
    const decoded = JSON.parse(await decodeIngestBody(wire, null))
    const { rows } = validateIngest(decoded)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'plain-1')
  })

  test('gzip bytes WITHOUT decompression are not valid JSON', () => {
    const wire = gzipSync(Buffer.from(JSON.stringify({ traces: [mkTrace()] })))
    assert.throws(() => JSON.parse(new TextDecoder().decode(wire)))
  })

  test('invalid gzip data rejects', async () => {
    const wire = toArrayBuffer(Buffer.from('not gzip at all'))
    await assert.rejects(decodeIngestBody(wire, 'gzip'))
  })

  test('decompression bomb over the size bound rejects', async () => {
    // Highly compressible payload that inflates past MAX_DECOMPRESSED_BYTES.
    const bomb = gzipSync(Buffer.alloc(MAX_DECOMPRESSED_BYTES + 1, 0x61))
    await assert.rejects(decodeIngestBody(toArrayBuffer(bomb), 'gzip'), /too large/)
  })
})
