import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../lib/supabase'
import type { DailyMetricRow } from '../../../../lib/trace-types'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Read from daily_metrics — pre-aggregated, tiny, never scans traces.
    const rows = (await supaRequest(
      `daily_metrics?user_id=eq.${encodeURIComponent(userId)}&order=date.desc&limit=90`
    )) as DailyMetricRow[]

    const now        = new Date()
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

    const allTime     = rows  ?? []
    const thisMonth   = allTime.filter((r) => r.date >= monthStart)

    const cost_this_month = parseFloat(
      thisMonth.reduce((a, r) => a + (r.total_cost ?? r.cost_usd ?? 0), 0).toFixed(4)
    )
    const traces_used = allTime.reduce((a, r) => a + (r.trace_count || 0), 0)

    // Calculate next billing date safely (handles December → January wrap)
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const next_billing = nextMonth.toISOString().slice(0, 10)

    return NextResponse.json({
      plan:             'Pro',
      traces_used,
      traces_limit:     100_000,
      cost_this_month,
      next_billing,
    })
  } catch (error) {
    console.error('[api/settings/billing] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
