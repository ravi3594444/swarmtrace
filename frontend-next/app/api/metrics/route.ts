import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Fetch everything we need in one query
    const rows = await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&select=cost_usd,input_tokens,output_tokens,timestamp,latency_sec,function&order=timestamp.desc&limit=5000`
    )

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        daily_burn_rate: 0,
        projected_monthly: 0,
        budget: 50000,
        spent: 0,
        token_volume: { input: 0, output: 0, chart: [] },
        latency_heatmap: [],
      })
    }

    // ── All-time totals ───────────────────────────────────────────────────
    const total_cost = rows.reduce((acc: number, r: any) => acc + (r.cost_usd || 0), 0)
    const total_in   = rows.reduce((acc: number, r: any) => acc + (r.input_tokens || 0), 0)
    const total_out  = rows.reduce((acc: number, r: any) => acc + (r.output_tokens || 0), 0)

    // ── Daily burn rate — cost of traces in the last 24 hours ─────────────
    const now = Date.now()
    const last24h = rows.filter((r: any) => {
      const ts = new Date(r.timestamp).getTime()
      return !isNaN(ts) && now - ts <= 24 * 60 * 60 * 1000
    })
    const daily_burn_rate    = parseFloat(last24h.reduce((acc: number, r: any) => acc + (r.cost_usd || 0), 0).toFixed(6))
    const projected_monthly  = parseFloat((daily_burn_rate * 30).toFixed(4))

    // ── Token volume chart — grouped by day of month ──────────────────────
    const byDay: Record<string, { input: number; output: number }> = {}
    rows.forEach((r: any) => {
      const d = new Date(r.timestamp)
      if (isNaN(d.getTime())) return
      const day = String(d.getUTCDate()).padStart(2, '0')
      if (!byDay[day]) byDay[day] = { input: 0, output: 0 }
      byDay[day].input  += r.input_tokens  || 0
      byDay[day].output += r.output_tokens || 0
    })
    const chart = Object.entries(byDay)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([day, v]) => ({ day, ...v }))

    // ── Latency heatmap — avg latency per function per 4-hour window ──────
    const TIME_SLOTS = ['0:00', '4:00', '8:00', '12:00', '16:00', '20:00']

    // Collect { slot -> { fn -> [latency_ms] } }
    const slotData: Record<string, Record<string, number[]>> = {}
    TIME_SLOTS.forEach(s => { slotData[s] = {} })

    rows.forEach((r: any) => {
      const d = new Date(r.timestamp)
      if (isNaN(d.getTime()) || !r.function || r.latency_sec == null) return
      const hour     = d.getUTCHours()
      const slotIdx  = Math.floor(hour / 4)
      const slot     = TIME_SLOTS[slotIdx]
      const fn       = r.function
      const latency  = Math.round((r.latency_sec || 0) * 1000)
      if (!slotData[slot][fn]) slotData[slot][fn] = []
      slotData[slot][fn].push(latency)
    })

    // Get top 5 functions by call count so the chart isn't too wide
    const fnCounts: Record<string, number> = {}
    rows.forEach((r: any) => { if (r.function) fnCounts[r.function] = (fnCounts[r.function] || 0) + 1 })
    const topFns = Object.entries(fnCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([fn]) => fn)

    const latency_heatmap = TIME_SLOTS.map(slot => {
      const entry: Record<string, any> = { time: slot }
      topFns.forEach(fn => {
        const vals = slotData[slot][fn]
        entry[fn] = vals && vals.length > 0
          ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
          : 0
      })
      return entry
    })

    return NextResponse.json({
      daily_burn_rate,
      projected_monthly,
      budget: 50000,
      spent: parseFloat(total_cost.toFixed(6)),
      token_volume: { input: total_in, output: total_out, chart },
      latency_heatmap,
      top_functions: topFns,   // send to frontend so it knows which keys to render
    })
  } catch (error) {
    console.error('[api/metrics] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
