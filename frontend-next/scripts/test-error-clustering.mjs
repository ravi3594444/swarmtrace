/**
 * Test: error clustering contract.
 *
 * Uses Node's built-in node:test runner + tsx (to import .ts directly).
 * Guards that near-identical errors (differing only in ids/numbers/paths)
 * collapse into a single cluster, and that distinct exception types stay
 * separate.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { clusterErrors, errorSignature } from '../lib/error-clustering.ts'

function mkTrace(error, overrides = {}) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    function: 'my_agent',
    args: '()',
    output: '',
    latency_sec: 0.1,
    error,
    timestamp: '2026-07-07T10:00:00.000Z',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    ...overrides,
  }
}

describe('errorSignature', () => {
  test('extracts the exception type before the colon', () => {
    assert.equal(errorSignature('ValueError: bad thing').type, 'ValueError')
  })

  test('falls back to Error when there is no typed prefix', () => {
    assert.equal(errorSignature('something exploded').type, 'Error')
  })

  test('normalizes numbers, ids, paths and quotes to a stable signature', () => {
    const a = errorSignature('ValueError: user 12345 not found at /tmp/a/b.py')
    const b = errorSignature('ValueError: user 98765 not found at /var/log/x.py')
    assert.equal(a.signature, b.signature)
  })

  test('keeps genuinely different messages in different signatures', () => {
    const a = errorSignature('ValueError: user not found')
    const b = errorSignature('ValueError: connection refused')
    assert.notEqual(a.signature, b.signature)
  })
})

describe('clusterErrors', () => {
  test('collapses 50 id-varying errors into one cluster', () => {
    const traces = Array.from({ length: 50 }, (_, i) =>
      mkTrace(`TimeoutError: request 0x${i.toString(16)} timed out after ${i}ms`)
    )
    const clusters = clusterErrors(traces)
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].count, 50)
    assert.equal(clusters[0].type, 'TimeoutError')
  })

  test('ignores successful traces', () => {
    const clusters = clusterErrors([mkTrace(null), mkTrace('KeyError: x')])
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].type, 'KeyError')
  })

  test('separates distinct exception types and sorts by count', () => {
    const traces = [
      mkTrace('ValueError: a', { function: 'f1' }),
      mkTrace('ValueError: b-differs'),
      mkTrace('TimeoutError: t', { function: 'f2' }),
      mkTrace('TimeoutError: t', { function: 'f3' }),
      mkTrace('TimeoutError: t'),
    ]
    const clusters = clusterErrors(traces)
    assert.equal(clusters.length, 3)
    assert.equal(clusters[0].type, 'TimeoutError')
    assert.equal(clusters[0].count, 3)
    // most frequent function first
    assert.ok(clusters[0].functions.length >= 1)
  })
})
