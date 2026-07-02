import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = (await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=500`
    )) as Trace[]

    // ── Identify "agents" ──────────────────────────────────────────────────
    // swarmtrace >= 0.3.0 stamps every span with a `kind`
    // ('agent' | 'tool' | 'llm' | 'function') and an `agent_id`/`agent_name`
    // — the id/name of the @observe(kind="agent") span it belongs to (its
    // own id, for agent spans themselves). Older SDK versions and direct
    // /ingest callers default to kind='agent', agent_id=id, agent_name=
    // function via /api/ingest, so every row here already has these fields.
    //
    // Grouping is now a flat group-by on agent_id — no parent_id tree-
    // walking needed, and it stays correct even if intermediate spans are
    // missing from this 500-row window. A group only becomes an agent card
    // if it contains the kind='agent' span that defines it; a lone
    // tool/llm/function call with no enclosing agent (agent_id === its own
    // id, kind !== 'agent') never becomes a phantom agent.
    const groups: Record<string, Trace[]> = {}
    rows.forEach((r) => { (groups[r.agent_id!] ||= []).push(r) })

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const agents = Object.entries(groups)
      .filter(([id, traces]) => traces.some((t) => t.kind === 'agent' && t.id === id))
      .map(([id, traces]) => {
        const runs        = traces.filter((t) => t.kind === 'agent' && t.id === id)
        const latestRun   = runs[0]
        const latestEvent = traces[0]
        const isRecent    = latestEvent.timestamp >= fiveMinutesAgo

        const errorCount  = traces.filter((t) => t.error).length
        const tokens      = traces.reduce(
          (acc, t) => acc + (t.input_tokens || 0) + (t.output_tokens || 0), 0
        )
        const successRate = ((traces.length - errorCount) / traces.length) * 100

        // RUNNING = had a successful trace in the last 5 min
        // ERROR   = latest trace has an error
        // IDLE    = no recent activity
        const status = latestEvent.error
          ? 'ERROR'
          : isRecent ? 'RUNNING' : 'IDLE'

        return {
          id,
          name:         latestRun.agent_name,
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
        }
      })

    return NextResponse.json({ agents })
  } catch (error) {
    console.error('[api/agents] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
