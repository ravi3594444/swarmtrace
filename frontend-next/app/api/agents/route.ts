import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'
import { deriveAgentCards } from '@/lib/derive-agent-cards'

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

    // Agent derivation logic lives in lib/derive-agent-cards.ts so it can
    // be unit-tested with node:test (see scripts/test-derive-agent-cards.mjs).
    // The contract between this route and the SDK's agent_id assignment is
    // locked by tests/test_tracer.py::test_api_agents_filter_contract.
    const agents = deriveAgentCards(rows)

    return NextResponse.json({ agents })
  } catch (error) {
    console.error('[api/agents] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
