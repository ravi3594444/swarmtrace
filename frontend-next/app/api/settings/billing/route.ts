import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest } from '../../../../lib/supabase'
import type { DailyMetricRow } from '../../../../lib/trace-types'

/**
 * Plan definitions. Until Stripe billing is wired up, every signed-in user
 * is on the Hobby plan. The Pro plan is advertised in the UI as "Coming
 * Soon" — when billing goes live, the plan field will be derived from the
 * user's subscription status instead of being hardcoded here.
 *
 * KEEP THESE LIMITS IN SYNC with the plan cards in
 * `app/settings/page.tsx` (BillingTab). The UI reads `plan` and
 * `traces_limit` from this endpoint so the two never drift.
 */
const PLANS = {
  Hobby: {
    name: 'Hobby' as const,
    traces_limit: 10_000,
    retention_days: 7,
  },
  // Pro/Enterprise are defined here for forward-compatibility, but not yet
  // returned — billing isn't live.
  Pro: {
    name: 'Pro' as const,
    traces_limit: 1_000_000,
    retention_days: 90,
  },
} as const

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // Read from daily_metrics — pre-aggregated, tiny, never scans traces.
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    const rows = (await supaUserRequest(
      `daily_metrics?user_id=eq.${encodeURIComponent(userId)}&order=date.desc&limit=90`,
      userId
    )) as DailyMetricRow[]

    const now        = new Date()
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

    const allTime     = rows  ?? []
    const thisMonth   = allTime.filter((r) => r.date >= monthStart)

    const cost_this_month = parseFloat(
      thisMonth.reduce((a, r) => a + (r.total_cost ?? r.cost_usd ?? 0), 0).toFixed(4)
    )
    const traces_used = allTime.reduce((a, r) => a + (r.trace_count || 0), 0)

    // Calculate next billing date safely (handles December → January wrap).
    // For Hobby (free), this is just the start of next month — useful as a
    // "limits reset" date in the UI.
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const next_billing = nextMonth.toISOString().slice(0, 10)

    // Until Stripe is live, everyone is on Hobby. When billing ships, this
    // becomes a lookup against the user's subscription record.
    const plan = PLANS.Hobby

    return NextResponse.json({
      plan:             plan.name,
      traces_used,
      traces_limit:     plan.traces_limit,
      retention_days:   plan.retention_days,
      cost_this_month,
      next_billing,
    })
  } catch (error) {
    console.error('[api/settings/billing] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
