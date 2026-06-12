import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../lib/supabase'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await supaRequest(
      `traces?user_id=eq.${encodeURIComponent(userId)}&select=cost_usd`
    )
    const total_cost = rows.reduce((acc: number, r: any) => acc + (r.cost_usd || 0.0), 0)

    return NextResponse.json({
      plan: 'Pro',
      traces_used: rows.length,
      traces_limit: 100000,
      cost_this_month: parseFloat(total_cost.toFixed(4)),
      next_billing: '2026-07-01',
    })
  } catch (error) {
    console.error('[api/settings/billing] request failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
