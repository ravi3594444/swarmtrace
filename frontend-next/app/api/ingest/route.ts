import { NextResponse } from 'next/server'
import { supaRequest } from '../../../lib/supabase'
import crypto from 'crypto'

export async function POST(req: Request) {
  const apiKey = req.headers.get('X-API-Key')
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing X-API-Key header' }, { status: 401 })
  }

  try {
    const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex')
    // 1. Resolve API key and map it to user_id
    const keys = await supaRequest(`api_keys?key=eq.${hashedKey}&revoked=eq.false&limit=1`)
    if (!keys || keys.length === 0) {
      return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 })
    }

    const { user_id } = keys[0]
    const payload = await req.json()

    const row = {
      id: payload.id,
      user_id,
      parent_id: payload.parent_id || null,
      function: payload.function,
      args: payload.args ?? '',
      output: payload.output ?? '',
      latency_sec: payload.latency_sec ?? 0.0,
      error: payload.error ?? null,
      timestamp: payload.timestamp,
      input_tokens: payload.input_tokens ?? 0,
      output_tokens: payload.output_tokens ?? 0,
      cost_usd: payload.cost_usd ?? 0.0,
    }

    // 2. Insert trace row
    await supaRequest('traces', {
      method: 'POST',
      body: JSON.stringify(row),
    })

    // 3. Keep last_used updated
    try {
      await supaRequest(`api_keys?id=eq.${keys[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_used: new Date().toISOString() }),
      })
    } catch (err) {
      console.error('Failed to update API key last_used:', err)
    }

    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('[api/ingest] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
