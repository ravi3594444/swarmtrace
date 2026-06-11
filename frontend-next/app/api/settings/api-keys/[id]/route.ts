import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../../lib/supabase'

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: keyId } = await params

  try {
    // Soft delete key
    await supaRequest(`api_keys?id=eq.${keyId}&user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ revoked: true }),
    })
    return NextResponse.json({ status: 'revoked' })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}