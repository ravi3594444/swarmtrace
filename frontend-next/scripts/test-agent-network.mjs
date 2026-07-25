/**
 * Test: per-agent network graph contract for the Node Network Map.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { deriveAgentNetworkGraph } from '../lib/agent-network.ts'

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
    agent_name: 'Agent 1',
    session_id: null,
    attributes: null,
    ...overrides,
  }
}

describe('deriveAgentNetworkGraph', () => {
  test('derives orchestrator and sub-agent edges from nested agent spans', () => {
    const traces = [
      mkTrace({ id: 'root', kind: 'agent', agent_id: 'orch', agent_name: 'Orchestrator' }),
      mkTrace({ id: 'child', parent_id: 'root', kind: 'agent', agent_id: 'researcher', agent_name: 'Researcher' }),
      mkTrace({ id: 'llm', parent_id: 'child', kind: 'llm', agent_id: 'researcher', input_tokens: 20, output_tokens: 10 }),
    ]

    const graph = deriveAgentNetworkGraph(traces, new Date('2026-07-25T10:02:00.000Z'))
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))

    assert.equal(graph.nodes.length, 2)
    assert.equal(byId.get('orch')?.collaborationMode, 'orchestrator')
    assert.equal(byId.get('researcher')?.collaborationMode, 'sub_agent')
    assert.equal(byId.get('researcher')?.llmSpans, 1)
    assert.equal(byId.get('researcher')?.tokens, 30)
    assert.deepEqual(graph.edges.map((edge) => `${edge.source}->${edge.target}:${edge.relation}`), [
      'orch->researcher:orchestrates',
    ])
  })

  test('derives peer collaboration from agent spans sharing a trace_id', () => {
    const traces = [
      mkTrace({ id: 'a', kind: 'agent', agent_id: 'agent-a', agent_name: 'Agent A', trace_id: 'shared' }),
      mkTrace({ id: 'b', kind: 'agent', agent_id: 'agent-b', agent_name: 'Agent B', trace_id: 'shared', timestamp: '2026-07-25T10:01:00.000Z' }),
    ]

    const graph = deriveAgentNetworkGraph(traces, new Date('2026-07-25T10:04:00.000Z'))

    assert.equal(graph.edges.length, 1)
    assert.equal(graph.edges[0].relation, 'peer')
    assert.equal(graph.nodes.find((node) => node.id === 'agent-a')?.collaborationMode, 'peer')
    assert.equal(graph.nodes.find((node) => node.id === 'agent-b')?.collaborationMode, 'peer')
  })

  test('marks retrieval usage as a per-agent RAG badge count', () => {
    const graph = deriveAgentNetworkGraph([
      mkTrace({ id: 'agent', kind: 'agent', agent_id: 'rag-agent', agent_name: 'RAG Agent' }),
      mkTrace({ id: 'ret', parent_id: 'agent', kind: 'retrieval', function: 'vector_search', agent_id: 'rag-agent' }),
      mkTrace({ id: 'tool', parent_id: 'agent', kind: 'tool', function: 'rag_lookup', agent_id: 'rag-agent' }),
    ])

    const node = graph.nodes.find((n) => n.id === 'rag-agent')
    assert.equal(node?.ragSpans, 2)
    assert.equal(graph.summary.ragAgents, 1)
  })

  test('keeps isolated agents as solo nodes and highlights errors', () => {
    const graph = deriveAgentNetworkGraph([
      mkTrace({ id: 'solo', kind: 'agent', agent_id: 'solo', agent_name: 'Solo', error: 'boom' }),
    ], new Date('2026-07-25T10:10:00.000Z'))

    assert.equal(graph.nodes[0].collaborationMode, 'solo')
    assert.equal(graph.nodes[0].status, 'ERROR')
    assert.equal(graph.summary.soloAgents, 1)
    assert.equal(graph.summary.totalErrors, 1)
  })
})
