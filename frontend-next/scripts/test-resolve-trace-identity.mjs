/**
 * Test: resolveTraceIdentity — the fix for "kind is hardcoded on the MCP
 * path" (const kind = 'agent' in app/api/mcp/route.ts).
 *
 * Uses Node's built-in node:test runner + tsx (to import .ts directly).
 * Imports the REAL resolveTraceIdentity, same pattern as
 * test-derive-agent-cards.mjs — no inlined copy to go stale.
 *
 * Run:  npm test   (which runs: node --import tsx --test scripts/test-*.mjs)
 *
 * What this guards against:
 *   - Regressing back to a hardcoded kind='agent' for every MCP trace.
 *   - Accepting a tool/llm/function/retrieval trace with no agent_id,
 *     which would silently misattribute it (MCP has no context to infer
 *     the enclosing agent the way the Python SDK's contextvars can).
 *   - Breaking the bare-@observe-style stable-id aggregation for the
 *     'agent' kind (repeat calls of the same function should collapse
 *     into one dashboard card).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveTraceIdentity } from '../lib/resolve-trace-identity.ts'
import { stableAgentId } from '../lib/stable-agent-id.ts'

describe('resolveTraceIdentity', () => {
  test('defaults kind to "agent" when omitted (back-compat with pre-fix callers)', () => {
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

  test('kind="tool" without agent_id is rejected — MCP has no context to infer it', () => {
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

  test('regression guard: kind is never silently coerced to "agent" for a non-agent request', () => {
    // Pre-fix behavior hardcoded `const kind = 'agent'` regardless of any
    // caller input. This asserts the tool kind actually survives.
    const result = resolveTraceIdentity({
      function: 'qdrant_search',
      kind: 'retrieval',
      agent_id: 'a1',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.notEqual(result.kind, 'agent')
  })
})
