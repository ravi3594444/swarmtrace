/**
 * Test: Trace Architecture summary.
 *
 * The dashboard Architecture view must be derived from canonical trace fields
 * only, so it works for SDK, MCP, and OTLP spans without provider-specific UI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildArchitectureEdges,
  buildArchitectureLayers,
  formatCost,
  formatLatency,
  summarizeArchitecture,
  traceKind,
} from '../lib/architecture-summary.ts'

function mkTrace(overrides = {}) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    trace_id: 'run-1',
    function: 'fn',
    args: '()',
    output: '',
    latency_sec: 0.1,
    error: null,
    timestamp: '2026-07-25T10:00:00.000Z',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    kind: 'function',
    agent_id: 'agent-1',
    agent_name: 'agent',
    session_id: null,
    attributes: null,
    ...overrides,
  }
}

describe('architecture summary', () => {
  test('defaults missing kind to function', () => {
    assert.equal(traceKind(mkTrace({ kind: undefined })), 'function')
  })

  test('summarizes roots, linked spans, orphans, tokens, cost, and errors', () => {
    const root = mkTrace({ id: 'root', function: 'orchestrator', kind: 'agent', cost_usd: 0.01 })
    const llm = mkTrace({ id: 'llm', parent_id: 'root', kind: 'llm', input_tokens: 10, output_tokens: 5, cost_usd: 0.02 })
    const orphan = mkTrace({ id: 'orphan', parent_id: 'missing', kind: 'tool', error: 'boom' })

    const summary = summarizeArchitecture([root, llm, orphan])

    assert.deepEqual(summary.roots.map((t) => t.id), ['root'])
    assert.equal(summary.linked, 1)
    assert.equal(summary.orphaned, 1)
    assert.equal(summary.totalTokens, 15)
    assert.equal(summary.totalCost, 0.03)
    assert.equal(summary.totalErrors, 1)
  })

  test('groups layer components by kind and function name', () => {
    const traces = [
      mkTrace({ id: 'a1', kind: 'agent', function: 'orchestrator', timestamp: '2026-07-25T10:00:00.000Z' }),
      mkTrace({ id: 'a2', kind: 'agent', function: 'orchestrator', timestamp: '2026-07-25T10:01:00.000Z', latency_sec: 0.4 }),
      mkTrace({ id: 'tool1', kind: 'tool', function: 'search', error: 'timeout' }),
    ]

    const layers = buildArchitectureLayers(traces)
    const agentLayer = layers.find((layer) => layer.kind === 'agent')
    const toolLayer = layers.find((layer) => layer.kind === 'tool')

    assert.equal(agentLayer?.spans, 2)
    assert.equal(agentLayer?.components[0].name, 'orchestrator')
    assert.equal(agentLayer?.components[0].calls, 2)
    assert.equal(agentLayer?.components[0].representative.id, 'a2')
    assert.equal(toolLayer?.errors, 1)
    assert.equal(toolLayer?.components[0].name, 'search')
  })

  test('builds parent-to-child flow edges by kind', () => {
    const traces = [
      mkTrace({ id: 'root', kind: 'agent' }),
      mkTrace({ id: 'llm', parent_id: 'root', kind: 'llm' }),
      mkTrace({ id: 'tool', parent_id: 'root', kind: 'tool', error: 'failed' }),
      mkTrace({ id: 'ignored', parent_id: 'missing', kind: 'tool' }),
    ]

    const edges = buildArchitectureEdges(traces)

    assert.deepEqual(edges.map((edge) => `${edge.from}->${edge.to}:${edge.count}`), [
      'agent->llm:1',
      'agent->tool:1',
    ])
    assert.equal(edges.find((edge) => edge.to === 'tool')?.errors, 1)
  })

  test('formats compact metrics for dashboard cards', () => {
    assert.equal(formatLatency(0.123), '123ms')
    assert.equal(formatLatency(1.234), '1.23s')
    assert.equal(formatCost(0.001234), '$0.00123')
    assert.equal(formatCost(1.2), '$1.20')
  })
})
