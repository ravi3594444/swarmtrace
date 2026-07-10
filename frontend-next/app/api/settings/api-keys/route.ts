import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../lib/supabase'
import crypto from 'crypto'

interface ApiKeyRow {
  id: string
  name: string
  created_at: string
  last_used: string | null
  key_prefix: string
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    const keys = (await supaUserRequest(
      `api_keys?user_id=eq.${encodeURIComponent(userId)}&revoked=eq.false&order=created_at.desc`,
      userId
    )) as ApiKeyRow[]
    return NextResponse.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        created: k.created_at,
        last_used: k.last_used,
        // Show stored prefix — never reconstruct from the hash
        prefix: k.key_prefix + '...',
      }))
    })
  } catch (error) {
    console.error('[api/settings/api-keys] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json().catch(() => ({}))
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : 'New Key'

    // id and key are separate: id is a UUID used for DB lookups/deletion,
    // key is the secret shown once, stored only as a SHA-256 hash.
    const keyId = crypto.randomUUID()
    const rawKey = 'st_' + crypto.randomBytes(24).toString('hex')
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
    const keyPrefix = rawKey.substring(0, 10) // e.g. "st_a1b2c3d4"
    const now = new Date().toISOString()

    const payload = {
      id: keyId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      user_id: userId,
      name,
      created_at: now,
      last_used: null,
      revoked: false,
    }

    await supaUserRequest('api_keys', userId, {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    // Return the raw key ONCE — it is never retrievable again
    return NextResponse.json({ key: rawKey })
  } catch (error) {
    if (error instanceof RlsEnforcementError) {
      console.error('[api/settings/api-keys] POST RLS enforcement failed:', error.message)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/settings/api-keys] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
