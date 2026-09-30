import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../lib/supabase'
import type { DailyMetricRow } from '../../../../lib/trace-types'
import { createUserRateLimiter, rateLimitResponse } from '../../../../lib/api-auth'

/**
 * Plan definitions. Everyone is on Hobby until Stripe billing exists; Pro is
 * shown as "Coming Soon". Keep the limits in sync with BillingTab in
 * app/settings/page.tsx.
 */
const PLANS = {
  Hobby: {
    name: 'Hobby' as const,
    traces_limit: 10_000,
    retention_days: 7,
  },
  // Pro/Enterprise are defined but not returned yet.
  Pro: {
    name: 'Pro' as const,
    traces_limit: 1_000_000,
    retention_days: 90,
  },
} as const

const rateLimiter = createUserRateLimiter({ prefix: 'st_user_rl_billing' })

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  try {
    // daily_metrics is pre-aggregated, so this never scans traces. RLS is
    // enforced via the Clerk JWT; the user_id filter is a second guard.
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

    // Next billing date (handles the December wrap). For Hobby this is just
    // the limits-reset date.
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const next_billing = nextMonth.toISOString().slice(0, 10)

    // Everyone is on Hobby until billing exists.
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
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/settings/billing] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
