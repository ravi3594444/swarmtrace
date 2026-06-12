import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=100`
    )

    const active_agents = rows.length
    const errorCount = rows.filter((r: any) => r.error).length
    const total_throughput = rows.reduce(
      (acc: number, r: any) => acc + (r.input_tokens || 0) + (r.output_tokens || 0),
      0
    )
    const avg_latency_ms = rows.length > 0
      ? Math.round((rows.reduce((acc: number, r: any) => acc + (r.latency_sec || 0), 0) / rows.length) * 1000)
      : 0
    const system_health = rows.length > 0
      ? parseFloat((((rows.length - errorCount) / rows.length) * 100).toFixed(1))
      : 100

    const activity = [
      { time: '00:00', requests: active_agents > 0 ? active_agents * 50 : 0 },
      { time: '06:00', requests: active_agents > 0 ? active_agents * 80 : 0 },
      { time: '12:00', requests: active_agents > 0 ? active_agents * 120 : 0 },
      { time: '18:00', requests: active_agents > 0 ? active_agents * 100 : 0 },
      { time: '24:00', requests: active_agents > 0 ? active_agents * 90 : 0 },
    ]

    // Per-function success rates derived from real trace data.
    const byFn: Record<string, { total: number; errors: number }> = {}
    rows.forEach((r: any) => {
      const s = (byFn[r.function] ||= { total: 0, errors: 0 })
      s.total += 1
      if (r.error) s.errors += 1
    })
    const top_agents = Object.entries(byFn)
      .slice(0, 3)
      .map(([name, s], i) => ({
        id: `agt-${i}`,
        name,
        score: parseFloat((((s.total - s.errors) / s.total) * 100).toFixed(1)),
        status: s.errors === 0 ? 'ACTIVE' : 'DEGRADED',
      }))

    const events = rows.slice(0, 5).map((r: any) => ({
      timestamp: r.timestamp,
      type: r.error ? 'WARN' : 'INFO',
      message: r.error
        ? `Error in ${r.function}: ${r.error}`
        : `${r.function} completed successfully in ${r.latency_sec}s`,
    }))

    return NextResponse.json({
      system_health,
      active_agents,
      total_throughput,
      avg_latency_ms,
      activity,
      top_agents,
      events,
    })
  } catch (error) {
    console.error('[api/overview] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
