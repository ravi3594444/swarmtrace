import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'
import { deriveAgentCards } from '@/lib/derive-agent-cards'
import { createUserRateLimiter, rateLimitResponse } from '../../../lib/api-auth'
import {
  buildTracesQuery,
  parseSinceParam,
  isTruncated,
  DEFAULT_TRACE_LIMIT,
} from '../../../lib/trace-query'

const rateLimiter = createUserRateLimiter({ prefix: 'st_user_rl_agents' })

export async function GET(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    //
    // The `since` (date-range) filter is now pushed into the Supabase query
    // itself (&timestamp=gte.<iso>), not applied client-side after the
    // fetch. This fixes audit finding #4: previously, the 500-row limit
    // was applied at the DB BEFORE the since filter ran in JS, so a user
    // with >500 traces total would see only their 500 most-recent traces
    // regardless of which time range they selected — anything older than
    // the 500th-most-recent was silently invisible.
    const since = parseSinceParam(request.url)
    const rows = (await supaUserRequest(
      buildTracesQuery(userId, { since }),
      userId
    )) as Trace[]

    // Defense-in-depth: also filter client-side, in case of clock skew
    // between client and server or any timestamp format mismatch. The DB
    // filter is the actual fix; this just catches the edge cases.
    const filtered = since != null
      ? rows.filter((t) => {
          const ms = new Date(t.timestamp).getTime()
          return Number.isFinite(ms) && ms >= since
        })
      : rows

    // Agent derivation logic lives in lib/derive-agent-cards.ts so it can
    // be unit-tested with node:test (see scripts/test-derive-agent-cards.mjs).
    // The contract between this route and the SDK's agent_id assignment is
    // locked by tests/test_tracer.py::test_api_agents_filter_contract.
    const agents = deriveAgentCards(filtered)

    return NextResponse.json({
      agents,
      // Signals to the client that more rows likely exist beyond the 500-row
      // cap. The dashboard can show a "showing most recent N agents — older
      // data not included" indicator instead of silently truncating.
      truncated: isTruncated(rows, DEFAULT_TRACE_LIMIT),
      // Echo the applied filter so the client can confirm what window it's
      // actually seeing (vs. what it asked for).
      since_applied: since,
    })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/agents] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
