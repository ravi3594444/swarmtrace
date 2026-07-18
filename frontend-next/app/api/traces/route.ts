import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'
import {
  buildTracesQuery,
  parseSinceParam,
  parseBeforeParam,
  isTruncated,
  DEFAULT_TRACE_LIMIT,
} from '../../../lib/trace-query'

export async function GET(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    //
    // `since` and `before` are pushed into the Supabase query (not applied
    // post-fetch) so the 500-row cap applies to the user's selected window,
    // not to all-time. Audit finding #4: previously this route had no
    // time-range filter at all and just returned the 500 most-recent traces
    // — silently truncating anything older.
    //
    // `before` is the cursor for backward pagination: pass the oldest
    // timestamp seen in the current page to fetch the page before it. Not
    // currently used by the dashboard UI (which doesn't paginate), but
    // supported so pagination can be added later without a route change.
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
        function_name: r.function, // compatible fallback
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
      // True when the DB returned exactly 500 rows — signals that more
      // pages likely exist. The dashboard can offer a "Load older" button
      // that passes `before=<oldest timestamp>` to fetch the next page.
      // Audit finding #4: previously this was silent.
      truncated: isTruncated(rows, DEFAULT_TRACE_LIMIT),
    })
  } catch (error) {
    console.error('[api/traces] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
