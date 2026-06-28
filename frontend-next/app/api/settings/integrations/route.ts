import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

// In-memory store for connected state (replace with Supabase persist when ready)
const connectedState: Record<string, boolean> = {
  'swarmtrace-observe': true,
  'token-budget': true,
  'tool-attention': false,
  'scrapling': false,
  'regression-detector': false,
}

const INTEGRATIONS = [
  {
    id: 'swarmtrace-observe',
    name: 'swarmtrace @observe',
    description: 'Auto-traces all decorated functions',
    requires: null,
  },
  {
    id: 'token-budget',
    name: 'Token Budget',
    description: 'Monitors token limits per agent',
    requires: null,
  },
  {
    id: 'tool-attention',
    name: 'Tool Attention',
    description: 'Highlights tools contributing most to agent decisions',
    requires: 'sentence-transformers + faiss',
  },
  {
    id: 'scrapling',
    name: 'Scrapling',
    description: 'Captures and traces web scraping agent runs',
    requires: null,
  },
  {
    id: 'regression-detector',
    name: 'Regression Detector',
    description: 'LLM-based output regression detection across agent runs',
    requires: 'Optional: any LLM callable (or litai + LIGHTNING_API_KEY)',
  },
]

export async function GET() {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    integrations: INTEGRATIONS.map(i => ({
      ...i,
      connected: connectedState[i.id] ?? false,
    })),
  })
}

export async function PATCH(request: Request) {
  const { userId } = (await auth())
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { id, connected } = await request.json()
    if (!id || typeof connected !== 'boolean') {
      return NextResponse.json({ error: 'Missing id or connected' }, { status: 400 })
    }
    connectedState[id] = connected
    return NextResponse.json({ id, connected, ok: true })
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
}
