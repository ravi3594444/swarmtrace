// Calls native Next.js API Routes (Route Handlers) deployed on Vercel.
// Uses relative paths — no NEXT_PUBLIC_API_URL needed on the client.
// NOTE: next: { revalidate } is only honoured in Server Components / Route
// Handlers, not in 'use client' fetch calls. All fetches here are from
// client components, so we omit it to avoid silent confusion.
//
// Every helper below still returns null/false on failure (unchanged
// contract for existing callers) but now also surfaces the failure via
// reportFetchError() so it isn't indistinguishable from "no data".
import { reportFetchError } from './report-fetch-error'

export async function fetchOverview() {
  try {
    const res = await fetch('/api/overview')
    if (!res.ok) { reportFetchError('overview', () => { fetchOverview() }); return null }
    return res.json()
  } catch {
    reportFetchError('overview', () => { fetchOverview() })
    return null
  }
}

export async function fetchAgents(since?: number | null) {
  try {
    const url = since != null ? `/api/agents?since=${since}` : '/api/agents'
    const res = await fetch(url)
    if (!res.ok) { reportFetchError('agents', () => { fetchAgents(since) }); return null }
    return res.json()
  } catch {
    reportFetchError('agents', () => { fetchAgents(since) })
    return null
  }
}

export async function fetchTraces() {
  try {
    const res = await fetch('/api/traces')
    if (!res.ok) { reportFetchError('traces', () => { fetchTraces() }); return null }
    return res.json()
  } catch {
    reportFetchError('traces', () => { fetchTraces() })
    return null
  }
}

export async function fetchGraph(since?: number | null) {
  try {
    const url = since != null ? `/api/graph?since=${since}` : '/api/graph'
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) { reportFetchError('agent graph', () => { fetchGraph(since) }); return null }
    return res.json()
  } catch {
    reportFetchError('agent graph', () => { fetchGraph(since) })
    return null
  }
}

export async function fetchMetrics() {
  try {
    // cache: 'no-store' — always fresh. Staleness is managed by the
    // visibility-aware Realtime subscription in metrics/page.tsx.
    const res = await fetch('/api/metrics', { cache: 'no-store' })
    if (!res.ok) { reportFetchError('metrics', () => { fetchMetrics() }); return null }
    return res.json()
  } catch {
    reportFetchError('metrics', () => { fetchMetrics() })
    return null
  }
}

export async function fetchApiKeys() {
  try {
    const res = await fetch('/api/settings/api-keys')
    if (!res.ok) { reportFetchError('API keys', () => { fetchApiKeys() }); return null }
    return res.json()
  } catch {
    reportFetchError('API keys', () => { fetchApiKeys() })
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
    if (!res.ok) { reportFetchError('API keys'); return null }
    return res.json()
  } catch {
    reportFetchError('API keys')
    return null
  }
}

export async function revokeApiKey(id: string) {
  try {
    const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
    if (!res.ok) reportFetchError('API keys')
    return res.ok
  } catch {
    reportFetchError('API keys')
    return false
  }
}

export async function fetchBillingInfo() {
  try {
    const res = await fetch('/api/settings/billing')
    if (!res.ok) { reportFetchError('billing info', () => { fetchBillingInfo() }); return null }
    return res.json()
  } catch {
    reportFetchError('billing info', () => { fetchBillingInfo() })
    return null
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
