/**
 * Pure function: derive agent cards from a list of traces.
 *
 * Extracted from app/api/agents/route.ts so it can be unit-tested without
 * a live Supabase / Clerk context. The route handler now just fetches rows
 * and passes them here.
 *
 * CONTRACT (do not break without coordinating with swarmtrace/tracer.py):
 *   See docs/SDK_DASHBOARD_CONTRACT.md for the full agent_id/kind
 *   contract this function implements one half of. Summary:
 *   - Group traces by `agent_id`.
 *   - A group becomes an agent card iff it contains at least one
 *     `kind === 'agent'` span.
 *   - DO NOT re-add a `t.id === agent_id` check. That was an artifact of
 *     the old `agent_id = trace_id` invariant and breaks under the
 *     stable-id scheme (drops every bare-@observe agent). See
 *     tests/test_tracer.py::test_api_agents_filter_contract.
 *
 * Anti-phantom guarantee: an orphan tool/llm/function call with no
 * enclosing agent has `kind !== 'agent'` (the SDK only auto-resolves to
 * 'agent' when there's no enclosing agent context, AND it sets kind='agent'
 * only on the auto-resolved span itself — never on tool/llm/function
 * spans). So orphan spans are filtered out and never become phantom cards.
 */
import type { Trace } from '@/lib/trace-types'

export type AgentCard = {
  id: string
  name: string
  status: 'RUNNING' | 'IDLE' | 'ERROR'
  tasks: number
  tokens: string
  lastActive: string
  uptime: string
  success_rate: string
  current_task: string
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

export function deriveAgentCards(
  rows: Trace[],
  now: Date = new Date(),
): AgentCard[] {
  // Group by agent_id (defensive: skip rows with no agent_id — they can't
  // belong to any agent and would create a 'undefined' bucket otherwise).
  const groups = new Map<string, Trace[]>()
  for (const r of rows) {
    if (!r.agent_id) continue
    const arr = groups.get(r.agent_id)
    if (arr) arr.push(r)
    else groups.set(r.agent_id, [r])
  }

  const fiveMinutesAgo = new Date(now.getTime() - FIVE_MINUTES_MS).toISOString()

  const agents: AgentCard[] = []
  for (const [id, traces] of groups) {
    // A group is an agent iff it contains at least one kind='agent' span.
    // (See CONTRACT above — do NOT add `&& t.id === id`.)
    if (!traces.some((t) => t.kind === 'agent')) continue

    // FIX #10: `latestRun` / `latestEvent` below are picked by index [0],
    // which is only correct if the group is sorted most-recent-first.
    // The current caller (app/api/agents/route.ts) does sort upstream
    // (`order=timestamp.desc` in lib/trace-query.ts), but that was an
    // *implicit* cross-file invariant this function never enforced or
    // even documented — any future caller (a test, a new route, a
    // client-side filter that reorders) that passes unsorted rows would
    // silently get the wrong "latest" run/event with no error anywhere.
    // Sorting a copy here makes the function correct on its own terms
    // regardless of input order, matching what its own inline comments
    // already assume it does.
    const sorted = [...traces].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )

    const runs        = sorted.filter((t) => t.kind === 'agent')
    const latestRun   = runs[0]
    const latestEvent = sorted[0]
    const isRecent    = latestEvent.timestamp >= fiveMinutesAgo

    const errorCount  = traces.filter((t) => t.error).length
    const tokens      = traces.reduce(
      (acc, t) => acc + (t.input_tokens || 0) + (t.output_tokens || 0), 0
    )
    const successRate = ((traces.length - errorCount) / traces.length) * 100

    const status: AgentCard['status'] = latestEvent.error
      ? 'ERROR'
      : isRecent ? 'RUNNING' : 'IDLE'

    agents.push({
      id,
      name:         latestRun.agent_name ?? id,
      status,
      tasks:        runs.length,
      tokens:       `${Math.round(tokens / 1000)}K`,
      lastActive:   latestEvent.timestamp,
      uptime:       'n/a',
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
