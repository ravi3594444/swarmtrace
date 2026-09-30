import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'
import { createUserRateLimiter, rateLimitResponse } from '../../../lib/api-auth'
import {
  buildTracesQuery,
  parseSinceParam,
  parseBeforeParam,
  isTruncated,
  DEFAULT_TRACE_LIMIT,
} from '../../../lib/trace-query'

const rateLimiter = createUserRateLimiter({ prefix: 'st_user_rl_traces' })

export async function GET(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  try {
    // RLS is enforced via the user's Clerk JWT; the user_id filter is a
    // second guard. `since` and `before` go into the query so the 500-row cap
    // applies to the selected window. `before` is a cursor for paging back
    // (the UI doesn't paginate yet).
    const since  = parseSinceParam(request.url)
    const before = parseBeforeParam(request.url)
    const rows = (await supaUserRequest(
      buildTracesQuery(userId, { since, before }),
      userId
    )) as Trace[]
    return NextResponse.json({
      traces: rows.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        trace_id: r.trace_id ?? null,
        function: r.function,
        function_name: r.function, // compat fallback
        kind: r.kind,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        session_id: r.session_id ?? null,
        attributes: r.attributes ?? null,
        status: r.error ? 'ERROR' : 'SUCCESS',
        duration: Math.round((r.latency_sec || 0) * 1000),
        tokens_in: r.input_tokens || 0,
        tokens_out: r.output_tokens || 0,
        cost: r.cost_usd || 0.0,
        timestamp: r.timestamp,
        args: r.args || '{}',
        output: r.output || '{}',
        error: r.error,
      })),
      // true when the DB returned exactly 500 rows, i.e. more pages probably
      // exist (fetch them with before=<oldest timestamp>)
      truncated: isTruncated(rows, DEFAULT_TRACE_LIMIT),
    })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/traces] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
