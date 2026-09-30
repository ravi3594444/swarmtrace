/**
 * Derives agent cards from a list of traces. Pure so it can be tested
 * without Supabase/Clerk.
 *
 * Traces are grouped by agent_id, and a group becomes a card only if it has
 * at least one kind === 'agent' span, which keeps orphan tool/llm spans from
 * showing up as phantom agents. Don't add a `t.id === agent_id` check; it
 * drops bare-@observe agents. See docs/SDK_DASHBOARD_CONTRACT.md.
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
  // group by agent_id, skipping rows without one
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
    // a group is an agent iff it has at least one kind='agent' span
    if (!traces.some((t) => t.kind === 'agent')) continue

    // Sort a copy newest-first so [0] below is really the latest, whatever
    // order the caller passed in.
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
