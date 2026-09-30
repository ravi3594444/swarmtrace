// Client-side helpers for the Next.js API routes, using relative paths.
// next: { revalidate } is omitted because it only applies to server-side
// fetches and everything here runs in client components.
//
// Helpers return null/false on failure and also call reportFetchError() so
// that isn't mistaken for "no data". They take an optional AbortSignal, and
// aborted requests are ignored without an error toast.
import { reportFetchError } from './report-fetch-error'

/** True if the error is an AbortError (request cancelled). */
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
    // no-store: always fresh. Staleness is handled by the Realtime
    // subscription in metrics/page.tsx.
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
    // parse the body even on failure; the route's { error } message is more
    // useful than a generic fallback
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
