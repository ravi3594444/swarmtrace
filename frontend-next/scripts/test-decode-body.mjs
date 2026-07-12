/**
 * Test: lib/decode-body.ts — the generic gzip request-body decoder shared
 * by /api/ingest and /api/events (audit finding #6).
 *
 * lib/validate-ingest.ts's own decodeIngestBody/MAX_DECOMPRESSED_BYTES
 * tests (scripts/test-ingest-batch.mjs) already cover the ingest-bound
 * wrapper end-to-end; these tests exercise the underlying generic helper
 * directly, including a second, differently-sized bound (as /api/events
 * now uses) to prove the bound is actually per-call, not hardcoded.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import { decodeGzipBody } from '../lib/decode-body.ts'

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('decodeGzipBody', () => {
  test('passes through uncompressed bodies unchanged when Content-Encoding is absent', async () => {
    const text = JSON.stringify({ hello: 'world' })
    const bytes = toArrayBuffer(Buffer.from(text, 'utf8'))
    const decoded = await decodeGzipBody(bytes, null, 1024)
    assert.equal(decoded, text)
  })

  test('passes through unchanged when Content-Encoding is something other than gzip', async () => {
    const text = JSON.stringify({ hello: 'world' })
    const bytes = toArrayBuffer(Buffer.from(text, 'utf8'))
    const decoded = await decodeGzipBody(bytes, 'identity', 1024)
    assert.equal(decoded, text)
  })

  test('inflates a gzip-compressed body when Content-Encoding: gzip', async () => {
    const text = JSON.stringify({ event_type: 'screen_tick', n: 42 })
    const wire = toArrayBuffer(gzipSync(Buffer.from(text, 'utf8')))
    const decoded = await decodeGzipBody(wire, 'gzip', 1024)
    assert.equal(decoded, text)
  })

  test('is case-insensitive and trims whitespace on the Content-Encoding value', async () => {
    const text = JSON.stringify({ a: 1 })
    const wire = toArrayBuffer(gzipSync(Buffer.from(text, 'utf8')))
    assert.equal(await decodeGzipBody(wire, 'GZIP', 1024), text)
    assert.equal(await decodeGzipBody(wire, '  gzip  ', 1024), text)
  })

  test('rejects invalid gzip data', async () => {
    const notGzip = toArrayBuffer(Buffer.from('this is not gzip data', 'utf8'))
    await assert.rejects(decodeGzipBody(notGzip, 'gzip', 1024))
  })

  test('rejects a decompressed payload exceeding the caller-supplied bound', async () => {
    const bomb = gzipSync(Buffer.alloc(2000, 0x61)) // 2000 bytes of 'a', compresses tiny
    await assert.rejects(decodeGzipBody(toArrayBuffer(bomb), 'gzip', 1000), /too large/)
  })

  test('accepts a decompressed payload within a SMALL caller-supplied bound (events-sized)', async () => {
    // Proves the bound is genuinely per-call — /api/events passes 256 KB,
    // not ingest's 1 MB. A 500-byte payload must pass under a 1 KB bound.
    const text = JSON.stringify({ id: 'evt1', agent_id: 'a1', timestamp: new Date().toISOString() })
    const wire = toArrayBuffer(gzipSync(Buffer.from(text, 'utf8')))
    const decoded = await decodeGzipBody(wire, 'gzip', 1024)
    assert.equal(decoded, text)
  })

  test('a payload that fits under ingest\'s 1 MB bound but not events\' 256 KB bound is rejected only for the smaller bound', async () => {
    const big = gzipSync(Buffer.alloc(300 * 1024, 0x62)) // 300 KB decompressed
    const bigBuf = toArrayBuffer(big)
    // Fits comfortably under a 1 MB (ingest-sized) bound.
    const decoded = await decodeGzipBody(bigBuf, 'gzip', 1024 * 1024)
    assert.equal(decoded.length, 300 * 1024)
    // Rejected under a 256 KB (events-sized) bound.
    await assert.rejects(decodeGzipBody(bigBuf, 'gzip', 256 * 1024), /too large/)
  })
})
