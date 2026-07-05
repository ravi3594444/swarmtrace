import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    const rows = (await supaUserRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=500`,
      userId
    )) as Trace[]

    // ── Identify "agents" ──────────────────────────────────────────────────
    // swarmtrace >= 0.3.0 stamps every span with a `kind`
    // ('agent' | 'tool' | 'llm' | 'function') and an `agent_id`/`agent_name`.
    //  - Bare @observe (auto-resolved "agent") gets a STABLE agent_id derived
    //    from the function's qualified name, so repeat runs aggregate into
    //    one agent card with tasks=N. The span's own `id` is still a fresh
    //    uuid per call (so t.id !== agent_id for these spans).
    //  - Explicit @observe(kind="agent") gets a FRESH agent_id per call
    //    (== its own trace id), so swarm sub-agents within one run stay
    //    distinct. For these, t.id === agent_id still holds.
    //  - Older SDK versions and direct /ingest callers default to
    //    kind='agent', agent_id=id via /api/ingest backfill.
    //
    // Grouping is a flat group-by on agent_id — no parent_id tree-walking
    // needed, and it stays correct even if intermediate spans are missing
    // from this 500-row window.
    //
    // A group becomes an agent card iff it contains at least one
    // kind='agent' span. That span IS the defining/root span of the agent
    // (nested non-agent spans inherit the agent's agent_id via context;
    // nested EXPLICIT kind="agent" spans get their own fresh agent_id and
    // thus land in their own group). A lone tool/llm/function call with no
    // enclosing agent has kind !== 'agent' and is filtered out — no phantom
    // agents.
    //
    // NOTE: do NOT re-add a `t.id === agent_id` check here. That was an
    // artifact of the old `agent_id = trace_id` invariant and breaks under
    // the stable-id scheme (it would drop every bare-@observe agent). The
    // `t.kind === 'agent'` check alone is sufficient. See
    // test_api_agents_filter_contract in tests/test_tracer.py.
    const groups: Record<string, Trace[]> = {}
    rows.forEach((r) => { (groups[r.agent_id!] ||= []).push(r) })

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const agents = Object.entries(groups)
      .filter(([, traces]) => traces.some((t) => t.kind === 'agent'))
      .map(([id, traces]) => {
        const runs        = traces.filter((t) => t.kind === 'agent')
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
