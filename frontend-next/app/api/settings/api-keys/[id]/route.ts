import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../../lib/supabase'

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: keyId } = await params

  try {
    // Soft delete key (scoped to the owner)
    await supaRequest(
      `api_keys?id=eq.${encodeURIComponent(keyId)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ revoked: true }),
      }
    )
    return NextResponse.json({ status: 'revoked' })
  } catch (error) {
    console.error('[api/settings/api-keys/:id] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
