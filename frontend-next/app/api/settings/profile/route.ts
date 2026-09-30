import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { createUserRateLimiter, rateLimitResponse } from '../../../../lib/api-auth'

// Tighter than the 120/min default since this is a write endpoint.
const rateLimiter = createUserRateLimiter({ limit: 20, prefix: 'st_user_rl_profile' })

export async function PATCH(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  try {
    const body = await req.json()
    const { fullName } = body

    if (typeof fullName !== 'string' || !fullName.trim()) {
      return NextResponse.json({ error: 'fullName is required' }, { status: 400 })
    }

    // split on the last space: "Ravi Kumar Das" gives first="Ravi Kumar", last="Das"
    const parts = fullName.trim().split(' ')
    const lastName  = parts.length > 1 ? parts.pop()! : ''
    const firstName = parts.join(' ')

    const client = await clerkClient()
    await client.users.updateUser(userId, { firstName, lastName })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[api/settings/profile] update failed:', err)
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
}
