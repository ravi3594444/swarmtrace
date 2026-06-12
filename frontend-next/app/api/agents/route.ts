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

    // Group traces by function name and derive real stats (no fake data).
    const groups: Record<string, any[]> = {}
    rows.forEach((r: any) => {
      ;(groups[r.function] ||= []).push(r)
    })

    const agents = Object.entries(groups).map(([name, traces]) => {
      const latest = traces[0]
      const errors = traces.filter((t: any) => t.error).length
      const tokens = traces.reduce(
        (acc: number, t: any) => acc + (t.input_tokens || 0) + (t.output_tokens || 0),
        0
      )
      const successRate = ((traces.length - errors) / traces.length) * 100
      return {
        id: latest.id,
        name,
        status: latest.error ? 'ERROR' : 'RUNNING',
        tasks: traces.length,
        tokens: `${Math.round(tokens / 1000)}K`,
        lastActive: latest.timestamp,
        uptime: 'n/a',
        success_rate: `${successRate.toFixed(1)}%`,
        current_task: latest.args ? latest.args.substring(0, 50) : 'Idle',
      }
    })

    return NextResponse.json({ agents })
  } catch (error) {
    console.error('[api/agents] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
