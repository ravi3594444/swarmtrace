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
    // @observe links nested calls via parent_id (set through contextvars),
    // so one agent run forms a tree:
    //
    //   run_hermes_agent          <- parent_id is null: this IS the agent
    //     ├─ llm/gemini-3.1-flash-lite   <- sub-operations, not their own agents
    //     ├─ tool/skill_manage
    //     └─ tool/skills_list
    //
    // Previously every unique `function` name — including the LLM/tool
    // sub-spans — was treated as a separate agent. Instead, walk each trace
    // up its parent chain to the root span; the root's function name is the
    // agent's identity, and everything beneath it (LLM calls, tool calls,
    // and any errors they raise) rolls up into that agent's stats.
    const byId: Record<string, any> = {}
    rows.forEach((r: any) => { byId[r.id] = r })

    const rootOf = (row: any) => {
      let current = row
      const seen = new Set<string>()
      while (current.parent_id && byId[current.parent_id] && !seen.has(current.id)) {
        seen.add(current.id)
        current = byId[current.parent_id]
      }
      return current
    }

    // A trace is a "root" (one agent run) if it has no parent, or its
    // parent fell outside the fetched window.
    const isRoot = (row: any) => !row.parent_id || !byId[row.parent_id]

    const groups: Record<string, any[]> = {}
    rows.forEach((r: any) => {
      const agentName = rootOf(r).function
      ;(groups[agentName] ||= []).push(r)
    })

    const agents = Object.entries(groups).map(([name, traces]) => {
      // `traces` keeps the original timestamp.desc order, so traces[0] is
      // this agent's most recent activity at any depth (run, LLM call, or
      // tool call), and roots[0] is its most recent top-level invocation.
      const roots = traces.filter(isRoot)
      const latestRoot = roots[0] || traces[0]
      const latestEvent = traces[0]

      const errorCount = traces.filter((t: any) => t.error).length
      const tokens = traces.reduce(
        (acc: number, t: any) => acc + (t.input_tokens || 0) + (t.output_tokens || 0),
        0
      )
      const successRate = ((traces.length - errorCount) / traces.length) * 100

      return {
        id: latestRoot.id,
        name,
        // ERROR if the agent's most recent activity at ANY depth failed —
        // e.g. a tool/LLM call inside the run — not just the root span.
        status: latestEvent.error ? 'ERROR' : 'RUNNING',
        tasks: roots.length,
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
