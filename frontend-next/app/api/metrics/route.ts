import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../lib/supabase'
import type { DailyMetricRow } from '../../../lib/trace-types'

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // One tiny table — one row per day per user. No scanning 5000 traces.
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    const rows = (await supaUserRequest(
      `daily_metrics?user_id=eq.${encodeURIComponent(userId)}&order=date.desc&limit=90`,
      userId
    )) as DailyMetricRow[]

    if (!rows || rows.length === 0) {
      return NextResponse.json({
        today: { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
        last_7_days:  { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
        this_month:   { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
        all_time:     { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
        chart: [],
      })
    }

    const now       = new Date()
    const todayStr  = now.toISOString().slice(0, 10)
    const day7Ago   = new Date(now); day7Ago.setUTCDate(now.getUTCDate() - 7)
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

    const agg = (subset: DailyMetricRow[]) => ({
      cost:       parseFloat(subset.reduce((a, r) => a + (r.total_cost ?? r.cost_usd ?? 0), 0).toFixed(6)),
      tokens_in:  subset.reduce((a, r) => a + (r.input_tokens || 0), 0),
      tokens_out: subset.reduce((a, r) => a + (r.output_tokens || 0), 0),
      traces:     subset.reduce((a, r) => a + (r.trace_count || 0), 0),
    })

    return NextResponse.json({
      today:       agg(rows.filter((r) => r.date === todayStr)),
      last_7_days: agg(rows.filter((r) => new Date(r.date) >= day7Ago)),
      this_month:  agg(rows.filter((r) => r.date >= monthStart)),
      all_time:    agg(rows),
      // chart: one point per day — frontend picks the period to display
      chart: rows.map((r) => ({
        date:   r.date,
        cost:   r.cost_usd      || 0,
        input:  r.input_tokens  || 0,
        output: r.output_tokens || 0,
        traces: r.trace_count   || 0,
      })).reverse(),
    })
  } catch (error) {
    console.error('[api/metrics] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
