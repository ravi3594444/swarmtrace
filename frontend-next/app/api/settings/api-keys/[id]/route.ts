import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../../lib/supabase'
import { createUserRateLimiter, rateLimitResponse } from '../../../../../lib/api-auth'

const rateLimiter = createUserRateLimiter({ limit: 20, prefix: 'st_user_rl_apikeys_delete' })

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await rateLimiter.check(userId)) return rateLimitResponse()

  const { id } = await params
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Missing key id' }, { status: 400 })
  }

  try {
    // Verify ownership before revoking. RLS is enforced via the Clerk JWT;
    // the user_id filter is a second guard.
    const existing = await supaUserRequest(
      `api_keys?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      userId
    )
    if (!existing || existing.length === 0) {
      return NextResponse.json({ error: 'Key not found' }, { status: 404 })
    }

    await supaUserRequest(`api_keys?id=eq.${encodeURIComponent(id)}`, userId, {
      method: 'PATCH',
      body: JSON.stringify({ revoked: true }),
    })

    // No cache to invalidate: ingest, events and mcp look keys up fresh, so
    // revocation applies on the next request (see lib/api-auth.ts).

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      console.error('[api/settings/api-keys/[id]] DELETE RLS enforcement failed:', error.message)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/settings/api-keys/[id]] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
