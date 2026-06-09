import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const { userId } = auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    integrations: [
      {
        id: "tracely-observe",
        name: "tracely @observe",
        connected: true,
        description: "Auto-traces all decorated functions",
      },
      {
        id: "token-budget",
        name: "Token Budget",
        connected: true,
        description: "Monitors token limits per agent",
      },
      {
        id: "tool-attention",
        name: "Tool Attention",
        connected: false,
        description: "Requires sentence-transformers + faiss",
      },
      {
        id: "scrapling",
        name: "Scrapling",
        connected: false,
        description: "Web scraping traces",
      },
      {
        id: "regression-detector",
        name: "Regression Detector",
        connected: false,
        description: "Requires LIGHTNING_API_KEY",
      },
    ]
  })
}