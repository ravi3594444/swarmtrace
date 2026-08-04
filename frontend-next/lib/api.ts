// Calls native Next.js API Routes (Route Handlers) deployed on Vercel.
// Uses relative paths — no NEXT_PUBLIC_API_URL needed on the client.
// NOTE: next: { revalidate } is only honoured in Server Components / Route
// Handlers, not in 'use client' fetch calls. All fetches here are from
// client components, so we omit it to avoid silent confusion.
//
// Every helper below still returns null/false on failure (unchanged
// contract for existing callers) but now also surfaces the failure via
// reportFetchError() so it isn't indistinguishable from "no data".
//
// All helpers accept an optional AbortSignal so callers can cancel stale
// requests when the user navigates away or a newer request supersedes an
// older one. Aborted requests are silently ignored (no error toast) —
// the AbortError is caught and treated as a no-op rather than a failure.
import { reportFetchError } from './report-fetch-error'

/** Returns true if an error is an AbortError (request was cancelled). */
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

export async function fetchOverview(signal?: AbortSignal) {
  try {
    const res = await fetch('/api/overview', { signal })
    if (!res.ok) { reportFetchError('overview', () => { fetchOverview() }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('overview', () => { fetchOverview() })
    return null
  }
}

export async function fetchAgents(since?: number | null, signal?: AbortSignal) {
  try {
    const url = since != null ? `/api/agents?since=${since}` : '/api/agents'
    const res = await fetch(url, { signal })
    if (!res.ok) { reportFetchError('agents', () => { fetchAgents(since) }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('agents', () => { fetchAgents(since) })
    return null
  }
}

export async function fetchTraces(since?: number | null, signal?: AbortSignal) {
  try {
    const url = since != null ? `/api/traces?since=${since}` : '/api/traces'
    const res = await fetch(url, { signal })
    if (!res.ok) { reportFetchError('traces', () => { fetchTraces(since) }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('traces', () => { fetchTraces(since) })
    return null
  }
}

export async function fetchGraph(since?: number | null, signal?: AbortSignal) {
  try {
    const url = since != null ? `/api/graph?since=${since}` : '/api/graph'
    const res = await fetch(url, { cache: 'no-store', signal })
    if (!res.ok) { reportFetchError('agent graph', () => { fetchGraph(since) }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('agent graph', () => { fetchGraph(since) })
    return null
  }
}

export async function fetchMetrics(signal?: AbortSignal) {
  try {
    // cache: 'no-store' — always fresh. Staleness is managed by the
    // visibility-aware Realtime subscription in metrics/page.tsx.
    const res = await fetch('/api/metrics', { cache: 'no-store', signal })
    if (!res.ok) { reportFetchError('metrics', () => { fetchMetrics() }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('metrics', () => { fetchMetrics() })
    return null
  }
}

export async function fetchApiKeys(signal?: AbortSignal) {
  try {
    const res = await fetch('/api/settings/api-keys', { signal })
    if (!res.ok) { reportFetchError('API keys', () => { fetchApiKeys() }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('API keys', () => { fetchApiKeys() })
    return null
  }
}

export async function createApiKey(name: string, signal?: AbortSignal) {
  try {
    const res = await fetch('/api/settings/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal,
    })
    // Parse the body even on failure — the route returns a specific
    // { error } message (plan limit / unauthorized / server error) that's
    // far more useful than a generic "API unavailable" fallback.
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      reportFetchError('API keys')
      return { error: data?.error || `Request failed (${res.status})` }
    }
    return data
  } catch (e) {
    if (isAbortError(e)) return null
    reportFetchError('API keys')
    return null
  }
}

export async function revokeApiKey(id: string, signal?: AbortSignal) {
  try {
    const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE', signal })
    if (!res.ok) reportFetchError('API keys')
    return res.ok
  } catch (e) {
    if (isAbortError(e)) return false
    reportFetchError('API keys')
    return false
  }
}

export async function fetchBillingInfo(signal?: AbortSignal) {
  try {
    const res = await fetch('/api/settings/billing', { signal })
    if (!res.ok) { reportFetchError('billing info', () => { fetchBillingInfo() }); return null }
    return res.json()
  } catch (e) {
    if (isAbortError(e)) return null
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
