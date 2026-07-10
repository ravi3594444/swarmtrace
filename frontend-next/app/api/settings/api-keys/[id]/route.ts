import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../../lib/supabase'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Missing key id' }, { status: 400 })
  }

  try {
    // Verify ownership before revoking — prevent one user revoking another's key.
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT). The user_id filter in the URL is defence-in-depth.
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
