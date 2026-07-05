import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { Trace } from '../../../lib/trace-types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    const rows = (await supaUserRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&order=timestamp.desc&limit=500`,
      userId
    )) as Trace[]

    if (!rows || rows.length === 0) {
      // Return 24 zero buckets (same shape as the real path) so the chart
      // renders an empty timeline instead of a 4-bucket stub.
      const emptyActivity = Array.from({ length: 24 }, (_, i) => {
        const d = new Date(Date.now() - (23 - i) * 60 * 60 * 1000)
        return { time: `${String(d.getUTCHours()).padStart(2, '0')}:00`, requests: 0 }
      })
      return NextResponse.json({
        system_health: 100, active_agents: 0,
        total_throughput: 0, avg_latency_ms: 0,
        activity: emptyActivity,
        top_agents: [], events: [],
      })
    }

    const errorCount = rows.filter((r) => r.error).length

    const total_throughput = rows.reduce(
      (acc, r) => acc + (r.input_tokens || 0) + (r.output_tokens || 0), 0
    )

    const avg_latency_ms = rows.length > 0
      ? Math.round(
          (rows.reduce((acc, r) => acc + (r.latency_sec || 0), 0) / rows.length) * 1000
        )
      : 0

    const system_health = rows.length > 0
      ? parseFloat((((rows.length - errorCount) / rows.length) * 100).toFixed(1))
      : 100

    // ── Per-function stats ────────────────────────────────────────────────────
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    const byFn: Record<string, { total: number; errors: number; lastSeen: string }> = {}
    rows.forEach((r) => {
      const s = (byFn[r.agent_name || r.function] ||= { total: 0, errors: 0, lastSeen: r.timestamp })
      s.total += 1
      if (r.error) s.errors += 1
      if (r.timestamp > s.lastSeen) s.lastSeen = r.timestamp
    })

    // active_agents = agents with a trace in the last 5 minutes only
    const active_agents = Object.values(byFn).filter(s => s.lastSeen >= fiveMinutesAgo).length

    // ── Real activity — last 24 hours, bucketed by actual hour ───────────────
    // Previous code bucketed ALL 500 traces by getUTCHours() (hour-of-day
    // 0-23), which made it a "typical hour of day" histogram across the
    // whole window — not a timeline. The chart label says "last 24h ·
    // hourly", so we bucket by actual date+hour, going back 24 hours from
    // now. Traces older than 24h are excluded.
    const now = new Date()
    const hourBuckets: { time: string; requests: number }[] = []
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60 * 60 * 1000)
      const label = `${String(d.getUTCHours()).padStart(2, '0')}:00`
      hourBuckets.push({ time: label, requests: 0 })
    }
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    rows.forEach((r) => {
      const ts = new Date(r.timestamp)
      if (ts < twentyFourHoursAgo) return   // exclude traces older than 24h
      const hoursAgo = Math.floor((now.getTime() - ts.getTime()) / (60 * 60 * 1000))
      const bucketIdx = 23 - hoursAgo       // 0 = oldest, 23 = current hour
      if (bucketIdx >= 0 && bucketIdx < 24) {
        hourBuckets[bucketIdx].requests++
      }
    })
    const activity = hourBuckets

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

    const events = rows.slice(0, 5).map((r) => ({
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
