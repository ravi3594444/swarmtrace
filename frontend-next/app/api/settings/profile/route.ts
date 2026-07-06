import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { fullName } = body

    if (typeof fullName !== 'string' || !fullName.trim()) {
      return NextResponse.json({ error: 'fullName is required' }, { status: 400 })
    }

    // Split on the last space so "Ravi Kumar Das" → firstName="Ravi Kumar" lastName="Das"
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
