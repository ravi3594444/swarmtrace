import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../../lib/supabase'
import { invalidateAllKeyCaches } from '../../../../../lib/api-auth'

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

    // Drop every cached key_hash → user_id entry on this isolate so the next
    // /api/ingest or /api/events request re-checks Supabase and rejects the
    // revoked key immediately. Without this, a revoked key would still POST
    // successfully for up to 5 minutes on any warm isolate that already
    // cached it (the audit's finding #1). NOTE: this only covers THIS
    // isolate — other warm isolates will still serve the revoked key until
    // their cache TTL expires. Eliminating that residual window requires
    // moving key lookups to a shared store (Upstash Redis already used by
    // the rate limiter); accepted as documented for now.
    invalidateAllKeyCaches()

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
