/**
 * Test: thread grouping contract for the Threads dashboard.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { groupThreads } from '../lib/thread-grouping.ts'

function mkTrace(overrides = {}) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    function: 'fn',
    args: '()',
    output: '',
    latency_sec: 0.1,
    error: null,
    timestamp: '2026-07-07T10:00:00.000Z',
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    kind: 'function',
    agent_id: undefined,
    agent_name: undefined,
    session_id: undefined,
    ...overrides,
  }
}

describe('groupThreads', () => {
  test('groups by session_id and sorts threads by most recent activity', () => {
    const threads = groupThreads([
      mkTrace({ id: 'a1', session_id: 'session-a', timestamp: '2026-07-07T10:00:00.000Z' }),
      mkTrace({ id: 'a2', session_id: 'session-a', timestamp: '2026-07-07T10:02:00.000Z', cost_usd: 0.002 }),
      mkTrace({ id: 'b1', session_id: 'session-b', timestamp: '2026-07-07T11:00:00.000Z', error: 'boom' }),
      mkTrace({ id: 'ignored', session_id: null }),
    ])

    assert.equal(threads.length, 2)
    assert.equal(threads[0].sessionId, 'session-b')
    assert.equal(threads[0].hasError, true)
    assert.equal(threads[0].turnCount, 1)
    assert.equal(threads[1].sessionId, 'session-a')
    assert.equal(threads[1].turnCount, 2)
    assert.equal(threads[1].totalCost, 0.003)
    assert.equal(threads[1].totalTokens, 30)
  })

  test('keeps traces in conversation order', () => {
    const threads = groupThreads([
      mkTrace({ id: 'late', session_id: 'thread-1', timestamp: '2026-07-07T10:05:00.000Z' }),
      mkTrace({ id: 'early', session_id: 'thread-1', timestamp: '2026-07-07T10:00:00.000Z' }),
      mkTrace({ id: 'middle', session_id: 'thread-1', timestamp: '2026-07-07T10:02:30.000Z' }),
    ])

    assert.equal(threads.length, 1)
    assert.deepEqual(threads[0].traces.map((trace) => trace.id), ['early', 'middle', 'late'])
    assert.equal(threads[0].firstSeen, '2026-07-07T10:00:00.000Z')
    assert.equal(threads[0].lastSeen, '2026-07-07T10:05:00.000Z')
  })

  test('returns an empty list when no trace has a session_id', () => {
    assert.deepEqual(groupThreads([mkTrace({ session_id: null }), mkTrace({ session_id: undefined })]), [])
  })
})
