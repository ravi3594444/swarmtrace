import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=500`
    )

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        system_health: 100, active_agents: 0,
        total_throughput: 0, avg_latency_ms: 0,
        activity: [
          { time: '00:00', requests: 0 }, { time: '06:00', requests: 0 },
          { time: '12:00', requests: 0 }, { time: '18:00', requests: 0 },
        ],
        top_agents: [], events: [],
      })
    }

    const errorCount = rows.filter((r: any) => r.error).length

    const total_throughput = rows.reduce(
      (acc: number, r: any) => acc + (r.input_tokens || 0) + (r.output_tokens || 0), 0
    )

    const avg_latency_ms = rows.length > 0
      ? Math.round(
          (rows.reduce((acc: number, r: any) => acc + (r.latency_sec || 0), 0) / rows.length) * 1000
        )
      : 0

    const system_health = rows.length > 0
      ? parseFloat((((rows.length - errorCount) / rows.length) * 100).toFixed(1))
      : 100

    // ── Per-function stats ────────────────────────────────────────────────────
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const byFn: Record<string, { total: number; errors: number; lastSeen: string }> = {}
    rows.forEach((r: any) => {
      const s = (byFn[r.agent_name || r.function] ||= { total: 0, errors: 0, lastSeen: r.timestamp })
      s.total += 1
      if (r.error) s.errors += 1
      if (r.timestamp > s.lastSeen) s.lastSeen = r.timestamp
    })

    // active_agents = agents with a trace in the last 5 minutes only
    const active_agents = Object.values(byFn).filter(s => s.lastSeen >= fiveMinutesAgo).length

    // ── Real activity — bucket traces into 6-hour UTC windows ─────────────────
    const hourBuckets: Record<string, number> = {
      '00:00': 0, '06:00': 0, '12:00': 0, '18:00': 0,
    }
    rows.forEach((r: any) => {
      const hour = new Date(r.timestamp).getUTCHours()
      if      (hour <  6) hourBuckets['00:00']++
      else if (hour < 12) hourBuckets['06:00']++
      else if (hour < 18) hourBuckets['12:00']++
      else                hourBuckets['18:00']++
    })
    const activity = Object.entries(hourBuckets).map(([time, requests]) => ({ time, requests }))

    // ── Top agents — sort by total calls before taking top 3 ─────────────────
    const top_agents = Object.entries(byFn)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 3)
      .map(([name, s], i) => ({
        id:     `agt-${i}`,
        name,
        score:  parseFloat((((s.total - s.errors) / s.total) * 100).toFixed(1)),
        status: s.lastSeen >= fiveMinutesAgo
          ? (s.errors === 0 ? 'ACTIVE' : 'DEGRADED')
          : 'IDLE',
      }))

    const events = rows.slice(0, 5).map((r: any) => ({
      timestamp: r.timestamp,
      type:    r.error ? 'WARN' : 'INFO',
      message: r.error
        ? `Error in ${r.function}: ${r.error}`
        : `${r.function} completed in ${r.latency_sec}s`,
    }))

    return NextResponse.json({
      system_health, active_agents, total_throughput, avg_latency_ms,
      activity, top_agents, events,
    })
  } catch (error) {
    console.error('[api/overview] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
