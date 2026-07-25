import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'
import { deriveAgentNetworkGraph } from '../../../lib/agent-network'
import {
  buildTracesQuery,
  parseSinceParam,
  isTruncated,
} from '../../../lib/trace-query'

const GRAPH_TRACE_LIMIT = 2000

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const since = parseSinceParam(request.url)
    const rows = (await supaUserRequest(
      buildTracesQuery(userId, { since, limit: GRAPH_TRACE_LIMIT }),
      userId,
    )) as Trace[]

    const graph = deriveAgentNetworkGraph(rows)

    return NextResponse.json({
      graph,
      truncated: isTruncated(rows, GRAPH_TRACE_LIMIT),
      since_applied: since,
    })
  } catch (error) {
    console.error('[api/graph] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
