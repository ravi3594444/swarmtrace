import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../../lib/supabase'

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
    // Verify ownership before revoking — prevent one user revoking another's key
    const existing = await supaRequest(
      `api_keys?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`
    )
    if (!existing || existing.length === 0) {
      return NextResponse.json({ error: 'Key not found' }, { status: 404 })
    }

    await supaRequest(`api_keys?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ revoked: true }),
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('[api/settings/api-keys/[id]] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
