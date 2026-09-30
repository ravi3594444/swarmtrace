/**
 * Tests for resolveTraceIdentity (lib/resolve-trace-identity.ts), using the
 * real function. Covers kind defaulting to 'agent', agent_id being required
 * for non-agent kinds, and stable-id derivation for 'agent' calls.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveTraceIdentity } from '../lib/resolve-trace-identity.ts'
import { stableAgentId } from '../lib/stable-agent-id.ts'

describe('resolveTraceIdentity', () => {
  test('defaults kind to "agent" when omitted', () => {
    const result = resolveTraceIdentity({ function: 'my_agent' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.kind, 'agent')
  })

  test('kind="agent" with no agent_id derives a stable id from function (matches bare @observe)', () => {
    const first = resolveTraceIdentity({ function: 'my_agent' })
    const second = resolveTraceIdentity({ function: 'my_agent' })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (first.ok && second.ok) {
      assert.equal(first.agentId, second.agentId, 'same function must derive the same agent_id')
      assert.equal(first.agentId, stableAgentId('my_agent'))
    }
  })

  test('kind="agent" with an explicit agent_id uses it as-is (fresh-per-call opt-in)', () => {
    const result = resolveTraceIdentity({ function: 'my_agent', agent_id: 'explicit-id' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.agentId, 'explicit-id')
  })

  test('kind="tool" without agent_id is rejected', () => {
    const result = resolveTraceIdentity({ function: 'search_web', kind: 'tool' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /agent_id is required/)
  })

  test('kind="llm" without agent_id is rejected', () => {
    const result = resolveTraceIdentity({ function: 'call_model', kind: 'llm' })
    assert.equal(result.ok, false)
  })

  test('kind="retrieval" without agent_id is rejected (RAG path)', () => {
    const result = resolveTraceIdentity({ function: 'qdrant_search', kind: 'retrieval' })
    assert.equal(result.ok, false)
  })

  test('kind="tool" WITH agent_id is accepted and passes it through unchanged', () => {
    const result = resolveTraceIdentity({
      function: 'search_web',
      kind: 'tool',
      agent_id: 'enclosing-agent-id',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.kind, 'tool')
      assert.equal(result.agentId, 'enclosing-agent-id')
    }
  })

  test('agent_name defaults to function when not provided', () => {
    const result = resolveTraceIdentity({ function: 'my_agent' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.agentName, 'my_agent')
  })

  test('agent_name is used as-is when provided', () => {
    const result = resolveTraceIdentity({ function: 'my_agent', agent_name: 'Orchestrator' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.agentName, 'Orchestrator')
  })

  test('kind is never silently coerced to "agent" for a non-agent request', () => {
    // the old code hardcoded kind='agent'; make sure the tool kind survives
    const result = resolveTraceIdentity({
      function: 'qdrant_search',
      kind: 'retrieval',
      agent_id: 'a1',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.notEqual(result.kind, 'agent')
  })
})
