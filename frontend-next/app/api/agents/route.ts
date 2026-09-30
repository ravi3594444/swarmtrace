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
    // RLS is enforced via the user's Clerk JWT; the user_id filter is a
    // second guard. `since` is pushed into the query so the 500-row limit
    // applies to the selected window.
    const since = parseSinceParam(request.url)
    const rows = (await supaUserRequest(
      buildTracesQuery(userId, { since }),
      userId
    )) as Trace[]

    // also filter here in case of clock skew or timestamp format mismatch
    const filtered = since != null
      ? rows.filter((t) => {
          const ms = new Date(t.timestamp).getTime()
          return Number.isFinite(ms) && ms >= since
        })
      : rows

    // Agent derivation is in lib/derive-agent-cards.ts (tested separately).
    const agents = deriveAgentCards(filtered)

    return NextResponse.json({
      agents,
      // true when the 500-row cap was hit, so the client can flag truncation
      truncated: isTruncated(rows, DEFAULT_TRACE_LIMIT),
      // echo the applied filter so the client sees which window it got
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
