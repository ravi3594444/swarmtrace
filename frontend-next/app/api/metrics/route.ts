import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../lib/supabase'
import type { DailyMetricRow } from '../../../lib/trace-types'
import { createUserRateLimiter, rateLimitResponse } from '../../../lib/api-auth'

const rateLimiter = createUserRateLimiter({ prefix: 'st_user_rl_metrics' })

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  try {
    // One row per day per user. RLS is enforced via the Clerk JWT; the
    // user_id filter is a second guard.
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
    // Compare calendar-date strings (YYYY-MM-DD), not Dates, so the window
    // doesn't shift with the time of day. "Last 7 days" is today plus the 6
    // before it, so the inclusive boundary is 6 days ago.
    const day6AgoDate = new Date(now)
    day6AgoDate.setUTCDate(now.getUTCDate() - 6)
    const day6AgoStr = day6AgoDate.toISOString().slice(0, 10)
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

    const agg = (subset: DailyMetricRow[]) => ({
      cost:       parseFloat(subset.reduce((a, r) => a + (r.total_cost ?? r.cost_usd ?? 0), 0).toFixed(6)),
      tokens_in:  subset.reduce((a, r) => a + (r.input_tokens || 0), 0),
      tokens_out: subset.reduce((a, r) => a + (r.output_tokens || 0), 0),
      traces:     subset.reduce((a, r) => a + (r.trace_count || 0), 0),
    })

    return NextResponse.json({
      today:       agg(rows.filter((r) => r.date === todayStr)),
      last_7_days: agg(rows.filter((r) => r.date >= day6AgoStr)),
      this_month:  agg(rows.filter((r) => r.date >= monthStart)),
      all_time:    agg(rows),
      // chart: one point per day, the frontend picks the period to show
      chart: rows.map((r) => ({
        date:   r.date,
        cost:   r.cost_usd      || 0,
        input:  r.input_tokens  || 0,
        output: r.output_tokens || 0,
        traces: r.trace_count   || 0,
      })).reverse(),
    })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/metrics] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
