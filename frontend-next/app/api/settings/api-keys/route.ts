import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest } from '../../../../lib/supabase'
import crypto from 'crypto'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const keys = await supaRequest(`api_keys?user_id=eq.${userId}&revoked=eq.false&order=created_at.desc`)
    return NextResponse.json({
      keys: keys.map((k: any) => ({
        id: k.id,
        name: k.name,
        created: k.created_at,
        last_used: k.last_used,
        prefix: k.prefix + '...',
      }))
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const name = body.name || 'New Key'
    const secret = 'st_' + crypto.randomBytes(24).toString('hex')
    const hashedKey = crypto.createHash('sha256').update(secret).digest('hex')
    const keyId = crypto.randomUUID()
    const prefix = secret.substring(0, 8)
    const now = new Date().toISOString()

    const payload = {
      id: keyId,
      key: hashedKey,
      prefix: prefix,
      user_id: userId,
      name,
      created_at: now,
      last_used: null,
      revoked: false,
    }

    await supaRequest('api_keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    return NextResponse.json({ key: secret })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}