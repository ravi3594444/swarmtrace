import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { supaRequest, supaUserRequest } from '@/lib/supabase'

const INTEGRATIONS_META = [
  { id: 'swarmtrace-observe', name: 'swarmtrace @observe',   description: 'Auto-traces all decorated functions',                             requires: null,                                                          default_connected: true  },
  { id: 'token-budget',       name: 'Token Budget',          description: 'Monitors token limits per agent',                                  requires: null,                                                          default_connected: true  },
  { id: 'tool-attention',     name: 'Tool Attention',        description: 'Highlights tools contributing most to agent decisions',            requires: 'sentence-transformers + faiss',                               default_connected: false },
  { id: 'scrapling',          name: 'Scrapling',             description: 'Captures and traces web scraping agent runs',                      requires: null,                                                          default_connected: false },
  { id: 'regression-detector', name: 'Regression Detector', description: 'LLM-based output regression detection across agent runs',          requires: 'Optional: any LLM callable (or litai + LIGHTNING_API_KEY)',  default_connected: false },
]

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let savedRows: Array<{ integration_id: string; connected: boolean }> = []
  try {
    // supaUserRequest enforces Postgres RLS at the DB level (per-user Clerk
    // JWT in the Authorization header). The user_id filter in the URL is
    // now defence-in-depth, not the only guard.
    savedRows = await supaUserRequest(
      `user_integrations?user_id=eq.${encodeURIComponent(userId)}&select=integration_id,connected`,
      userId
    ) || []
  } catch {
    // table may not exist yet — fall back to defaults
  }

  const savedMap = new Map(savedRows.map(r => [r.integration_id, r.connected]))

  const integrations = INTEGRATIONS_META.map(meta => ({
    id:          meta.id,
    name:        meta.name,
    description: meta.description,
    requires:    meta.requires,
    connected:   savedMap.has(meta.id) ? savedMap.get(meta.id)! : meta.default_connected,
  }))

  return NextResponse.json({ integrations })
}

export async function PATCH(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { id, connected } = await request.json()
    if (!id || typeof connected !== 'boolean') {
      return NextResponse.json({ error: 'Missing id or connected' }, { status: 400 })
    }

    await supaRequest('user_integrations', {
      method:  'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        user_id:        userId,
        integration_id: id,
        connected,
        connected_at: connected ? new Date().toISOString() : null,
        updated_at:   new Date().toISOString(),
      }),
    })

    return NextResponse.json({ id, connected, ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to save'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
