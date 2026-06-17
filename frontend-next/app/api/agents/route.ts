import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=500`
    )

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
    const groups: Record<string, any[]> = {}
    rows.forEach((r: any) => { (groups[r.agent_id] ||= []).push(r) })

    const agents = Object.entries(groups)
      .filter(([id, traces]) => traces.some((t: any) => t.kind === 'agent' && t.id === id))
      .map(([id, traces]) => {
        // `traces` keeps the original timestamp.desc order, so traces[0] is
        // this agent's most recent activity at any depth (run, LLM call, or
        // tool call), and runs[0] is its most recent top-level invocation.
        const runs = traces.filter((t: any) => t.kind === 'agent' && t.id === id)
        const latestRun   = runs[0]
        const latestEvent = traces[0]

        const errorCount = traces.filter((t: any) => t.error).length
        const tokens = traces.reduce(
          (acc: number, t: any) => acc + (t.input_tokens || 0) + (t.output_tokens || 0),
          0
        )
        const successRate = ((traces.length - errorCount) / traces.length) * 100

        return {
          id,
          name: latestRun.agent_name,
          // ERROR if the agent's most recent activity at ANY depth failed —
          // e.g. a tool/LLM call inside the run — not just the run itself.
          status: latestEvent.error ? 'ERROR' : 'RUNNING',
          tasks: runs.length,
          tokens: `${Math.round(tokens / 1000)}K`,
          lastActive: latestEvent.timestamp,
          uptime: 'n/a',
          success_rate: `${successRate.toFixed(1)}%`,
          current_task: latestEvent.error
            ? `Error in ${latestEvent.function}: ${latestEvent.error.substring(0, 80)}`
            : latestEvent.args
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
