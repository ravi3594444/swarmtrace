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
    return NextResponse.json({
      traces: rows.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        function: r.function,
        function_name: r.function, // compatible fallback
        kind: r.kind,
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        status: r.error ? 'ERROR' : 'SUCCESS',
        duration: Math.round((r.latency_sec || 0) * 1000),
        tokens_in: r.input_tokens || 0,
        tokens_out: r.output_tokens || 0,
        cost: r.cost_usd || 0.0,
        timestamp: r.timestamp,
        args: r.args || '{}',
        output: r.output || '{}',
        error: r.error,
      }))
    })
  } catch (error) {
    console.error('[api/traces] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
