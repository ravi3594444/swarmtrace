import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await supaRequest(`traces?user_id=eq.${userId}&order=timestamp.desc&limit=500`)
    return NextResponse.json({
      traces: rows.map((r: any) => ({
        id: r.id,
        parent_id: r.parent_id,
        function: r.function,
        function_name: r.function, // compatible fallback
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
