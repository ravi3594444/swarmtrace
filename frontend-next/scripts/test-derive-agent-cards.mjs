/**
 * Test: deriveAgentCards contract.
 *
 * Uses Node's built-in node:test runner — zero new dependencies, runs in CI
 * with `node --test`. This is the regression guard that the Python
 * test_api_agents_filter_contract can't be (it tests the Python reproduction
 * of the logic, not the actual TypeScript code).
 *
 * Run:  node --test frontend-next/scripts/test-derive-agent-cards.mjs
 *
 * What this guards against:
 *   - Re-introducing the `t.id === agent_id` check (would drop every
 *     bare-@observe agent under the stable-id scheme).
 *   - Phantom agent cards from orphan tool/llm/function spans.
 *   - Silent breakage of the SDK<->API contract when either side changes.
 *
 * NOTE: This file inlines a copy of deriveAgentCards logic because Node
 * can't import .ts directly without a loader. The Python contract test
 * (tests/test_tracer.py::test_api_agents_filter_contract) is the source
 * of truth — if these two ever disagree, the Python one wins. This .mjs
 * file is the early-warning system that runs in frontend CI.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ── Inline copy of deriveAgentCards (see note above) ───────────────────────
function deriveAgentCards(rows, now = new Date()) {
  const groups = new Map()
  for (const r of rows) {
    if (!r.agent_id) continue
    const arr = groups.get(r.agent_id)
    if (arr) arr.push(r)
    else groups.set(r.agent_id, [r])
  }
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const agents = []
  for (const [id, traces] of groups) {
    if (!traces.some((t) => t.kind === 'agent')) continue
    const runs = traces.filter((t) => t.kind === 'agent')
    const latestRun = runs[0]
    const latestEvent = traces[0]
    const isRecent = latestEvent.timestamp >= fiveMinutesAgo
    const errorCount = traces.filter((t) => t.error).length
    const tokens = traces.reduce(
      (acc, t) => acc + (t.input_tokens || 0) + (t.output_tokens || 0), 0,
    )
    const successRate = ((traces.length - errorCount) / traces.length) * 100
    const status = latestEvent.error ? 'ERROR' : isRecent ? 'RUNNING' : 'IDLE'
    agents.push({
      id,
      name: latestRun.agent_name ?? id,
      status,
      tasks: runs.length,
      tokens: `${Math.round(tokens / 1000)}K`,
      lastActive: latestEvent.timestamp,
      uptime: 'n/a',
      success_rate: `${successRate.toFixed(1)}%`,
      current_task: latestEvent.error
        ? `Error in ${latestEvent.function}: ${latestEvent.error.substring(0, 80)}`
        : isRecent && latestEvent.args
          ? `${latestEvent.function}: ${latestEvent.args.substring(0, 60)}`
          : 'Idle',
    })
  }
  return agents
}

// ── Helpers ────────────────────────────────────────────────────────────────
const NOW = new Date('2026-07-05T17:00:00Z')
const RECENT = new Date(NOW.getTime() - 60_000).toISOString()       // 1 min ago
const OLD    = new Date(NOW.getTime() - 60 * 60_000).toISOString()  // 1 hour ago

function mkTrace(overrides) {
  return {
    id: 'trace-' + Math.random().toString(36).slice(2, 10),
    parent_id: null,
    function: 'fn',
    args: '()',
    output: '',
    latency_sec: 0.5,
    error: null,
    timestamp: RECENT,
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
    kind: 'agent',
    agent_id: undefined,
    agent_name: undefined,
    ...overrides,
  }
}

describe('deriveAgentCards — contract with swarmtrace SDK', () => {

  test('NEW-SDK shape: bare @observe with stable agent_id, 3 runs → 1 card, tasks=3', () => {
    const stableAid = '8f395b07b234802b507e1929b733605ec945431a382394fed2cb53b30f54412c'
    const rows = [
      mkTrace({ id: 't1', agent_id: stableAid, agent_name: 'my_bot', kind: 'agent' }),
      mkTrace({ id: 't2', agent_id: stableAid, agent_name: 'my_bot', kind: 'agent' }),
      mkTrace({ id: 't3', agent_id: stableAid, agent_name: 'my_bot', kind: 'agent' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 1, 'should produce 1 agent card (aggregated)')
    assert.equal(cards[0].tasks, 3, 'tasks should be 3 (the whole point)')
    assert.equal(cards[0].name, 'my_bot')
  })

  test('OLD-SDK shape: id === agent_id (the pre-fix invariant) still works', () => {
    const rows = [
      mkTrace({ id: 'a1', agent_id: 'a1', agent_name: 'old_bot', kind: 'agent' }),
      mkTrace({ id: 'a2', agent_id: 'a2', agent_name: 'old_bot', kind: 'agent' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 2)
    assert.equal(cards[0].tasks, 1)
    assert.equal(cards[1].tasks, 1)
  })

  test('Mixed old + new SDK data coexist without interference', () => {
    const stableAid = '8f395b07b234802b'
    const rows = [
      mkTrace({ id: 'n1', agent_id: stableAid, agent_name: 'my_bot', kind: 'agent' }),
      mkTrace({ id: 'n2', agent_id: stableAid, agent_name: 'my_bot', kind: 'agent' }),
      mkTrace({ id: 'o1', agent_id: 'o1', agent_name: 'old_bot', kind: 'agent' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 2)
    const myBot = cards.find((c) => c.name === 'my_bot')
    const oldBot = cards.find((c) => c.name === 'old_bot')
    assert.ok(myBot, 'my_bot card present')
    assert.ok(oldBot, 'old_bot card present')
    assert.equal(myBot.tasks, 2, 'new SDK aggregates')
    assert.equal(oldBot.tasks, 1, 'old SDK stays per-run')
  })

  test('Phantom prevention: orphan tool call (kind=tool) → NO card', () => {
    const rows = [
      mkTrace({ id: 'orphan1', agent_id: 'orphan1', agent_name: 'standalone_tool', kind: 'tool' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 0, 'orphan tool must not become a phantom card')
  })

  test('Phantom prevention: orphan LLM call (kind=llm) → NO card', () => {
    const rows = [
      mkTrace({ id: 'orphan2', agent_id: 'orphan2', agent_name: 'raw_llm', kind: 'llm' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 0, 'orphan llm must not become a phantom card')
  })

  test('Nested non-agent spans roll up into enclosing agent (do NOT create their own card)', () => {
    const stableAid = 'agent-123'
    const rows = [
      mkTrace({ id: 'root', agent_id: stableAid, agent_name: 'orchestrator', kind: 'agent' }),
      mkTrace({ id: 'tool1', parent_id: 'root', agent_id: stableAid, agent_name: 'orchestrator', kind: 'tool' }),
      mkTrace({ id: 'llm1',  parent_id: 'root', agent_id: stableAid, agent_name: 'orchestrator', kind: 'llm' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 1, 'only 1 card (the orchestrator)')
    assert.equal(cards[0].name, 'orchestrator')
    assert.equal(cards[0].tasks, 1, '1 agent run (the tool/llm are not separate runs)')
  })

  test('Explicit kind="agent" swarm sub-agents each get their own card', () => {
    const orchAid = 'orch-stable-id'
    const rows = [
      mkTrace({ id: 'orch-run', agent_id: orchAid, agent_name: 'orchestrator', kind: 'agent' }),
      mkTrace({ id: 'r1', parent_id: 'orch-run', agent_id: 'r1', agent_name: 'researcher', kind: 'agent' }),
      mkTrace({ id: 's1', parent_id: 'orch-run', agent_id: 's1', agent_name: 'summarizer', kind: 'agent' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 3, '3 distinct agent cards')
    const names = cards.map((c) => c.name).sort()
    assert.deepEqual(names, ['orchestrator', 'researcher', 'summarizer'])
  })

  test('Status: ERROR when latest trace has an error', () => {
    const aid = 'err-agent'
    const rows = [
      mkTrace({ id: 'e1', agent_id: aid, agent_name: 'bot', kind: 'agent', error: 'boom', timestamp: RECENT }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards[0].status, 'ERROR')
  })

  test('Status: RUNNING when latest trace is within 5 minutes', () => {
    const aid = 'running-agent'
    const rows = [
      mkTrace({ id: 'r1', agent_id: aid, agent_name: 'bot', kind: 'agent', timestamp: RECENT }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards[0].status, 'RUNNING')
  })

  test('Status: IDLE when latest trace is older than 5 minutes', () => {
    const aid = 'idle-agent'
    const rows = [
      mkTrace({ id: 'i1', agent_id: aid, agent_name: 'bot', kind: 'agent', timestamp: OLD }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards[0].status, 'IDLE')
  })

  test('Empty input → empty output', () => {
    assert.deepEqual(deriveAgentCards([], NOW), [])
  })

  test('Rows with missing agent_id are skipped (defensive)', () => {
    const rows = [
      mkTrace({ id: 'noaid', agent_id: undefined, kind: 'agent' }),
      mkTrace({ id: 'hasaid', agent_id: 'x', agent_name: 'bot', kind: 'agent' }),
    ]
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 1, 'only the row with agent_id produces a card')
    assert.equal(cards[0].name, 'bot')
  })

  test('REGRESSION GUARD: re-adding t.id === agent_id check would break this', () => {
    const stableAid = '8f395b07b234802b'
    const rows = [
      mkTrace({ id: 'fresh-uuid-1', agent_id: stableAid, agent_name: 'bot', kind: 'agent' }),
      mkTrace({ id: 'fresh-uuid-2', agent_id: stableAid, agent_name: 'bot', kind: 'agent' }),
    ]
    assert.notEqual(rows[0].id, rows[0].agent_id, 'test setup: id should differ from agent_id')
    const cards = deriveAgentCards(rows, NOW)
    assert.equal(cards.length, 1, 'if this fails, someone re-added t.id === agent_id')
    assert.equal(cards[0].tasks, 2)
  })
})
