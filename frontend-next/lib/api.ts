// Calls native Next.js API Routes (Route Handlers) deployed on Vercel.
// Uses relative paths — no NEXT_PUBLIC_API_URL needed on the client.
// NOTE: next: { revalidate } is only honoured in Server Components / Route
// Handlers, not in 'use client' fetch calls. All fetches here are from
// client components, so we omit it to avoid silent confusion.

export async function fetchOverview() {
  try {
    const res = await fetch('/api/overview')
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function fetchAgents() {
  try {
    const res = await fetch('/api/agents')
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function fetchTraces() {
  try {
    const res = await fetch('/api/traces')
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function fetchMetrics() {
  try {
    // cache: 'no-store' — always fresh. Staleness is managed by the
    // visibility-aware Realtime subscription in metrics/page.tsx.
    const res = await fetch('/api/metrics', { cache: 'no-store' })
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function fetchApiKeys() {
  try {
    const res = await fetch('/api/settings/api-keys')
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function createApiKey(name: string) {
  try {
    const res = await fetch('/api/settings/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export async function revokeApiKey(id: string) {
  try {
    const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

export async function fetchBillingInfo() {
  try {
    const res = await fetch('/api/settings/billing')
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

export function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    const s = String(date.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
  } catch {
    return isoString
  }
}

export function formatRelativeTime(isoString: string): string {
  try {
    const diffMs   = Date.now() - new Date(isoString).getTime()
    const diffSecs = Math.floor(diffMs / 1000)
    const diffMins = Math.floor(diffSecs / 60)
    const diffHours = Math.floor(diffMins / 60)
    if (diffSecs  < 60) return `${diffSecs}s ago`
    if (diffMins  < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${Math.floor(diffHours / 24)}d ago`
  } catch {
    return isoString
  }
}
