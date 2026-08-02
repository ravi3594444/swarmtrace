import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaUserRequest, RlsEnforcementError } from '../../../../lib/supabase'
import { createUserRateLimiter, rateLimitResponse } from '../../../../lib/api-auth'
import crypto from 'crypto'

interface ApiKeyRow {
  id: string
  name: string
  created_at: string
  last_used: string | null
  key_prefix: string
}

const listRateLimiter = createUserRateLimiter({ limit: 60, prefix: 'st_user_rl_apikeys_list' })
// Tighter limit on key creation specifically — this is the sensitive
// operation (also already guarded by the MAX_KEYS_HOBBY plan check below).
const createRateLimiter = createUserRateLimiter({ limit: 10, prefix: 'st_user_rl_apikeys_create' })

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await listRateLimiter.check(userId)) return rateLimitResponse()

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
    if (error instanceof RlsEnforcementError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[api/settings/api-keys] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await createRateLimiter.check(userId)) return rateLimitResponse()

  try {
    // Enforce plan limits before creating a new key. The Hobby plan
    // (the only plan currently available — see /api/settings/billing)
    // allows 1 API key. Pro/Enterprise will allow more once billing is
    // live; for now everyone is on Hobby. Without this check, the UI
    // says "1 API key" on the Hobby plan card but the API silently
    // allowed unlimited keys.
    const MAX_KEYS_HOBBY = 1
    const existing = (await supaUserRequest(
      `api_keys?user_id=eq.${encodeURIComponent(userId)}&revoked=eq.false&select=id`,
      userId
    )) as { id: string }[]
    if (existing.length >= MAX_KEYS_HOBBY) {
      return NextResponse.json(
        { error: `Your plan allows ${MAX_KEYS_HOBBY} API key${MAX_KEYS_HOBBY !== 1 ? 's' : ''}. Revoke an existing key or upgrade to create more.` },
        { status: 402 }, // 402 Payment Required — signals a plan limit
      )
    }

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
