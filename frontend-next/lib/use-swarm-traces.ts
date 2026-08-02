'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Trace } from './trace-types'
import { fetchSwarmTraces } from './swarm-api'
import { useVisibleInterval } from '@/hooks/use-visible-interval'

/**
 * Hook backing the Traces page.
 *
 * Returns `truncated` (audit finding #4 follow-up) so the page can render
 * <TruncationBanner /> when the backend capped the result at 500 rows.
 * Previously the hook returned only `{ traces, loading, isLive, toggleLive }`
 * and the `truncated` flag from /api/traces was dropped at the lib/swarm-api.ts
 * layer — the backend was computing it but no client ever saw it.
 *
 * Audit finding: every poll re-fetched the full 500-row page (~0.48 MB),
 * even though the route already supports `?since=` server-side filtering
 * (lib/trace-query.ts). After the first full load, subsequent polls now
 * pass `since` = the newest timestamp already held, so the server only
 * returns rows added since the last poll — ~95-99% less data per tick.
 * New rows are merged (deduped by id) into the existing list rather than
 * replacing it. Polling also pauses while the tab is hidden (see
 * useVisibleInterval) and does one immediate catch-up fetch on return.
 */
export function useSwarmTraces(pollMs = 8000) {
  const [traces, setTraces] = useState<Trace[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(true)
  // Monotonic request ID + cancelled flag — guards against two race conditions:
  //   1. A slow in-flight request resolving AFTER a newer one (stale data
  //      overwrites fresh). reqId lets us ignore the stale response.
  //   2. The initial fetch resolving after the component unmounts (React
  //      state update on unmounted component). cancelled lets us skip it.
  const reqId = useRef(0)
  const mounted = useRef(true)
  // Newest trace timestamp (epoch ms) currently held. null until the first
  // full load completes; drives the `since` param on incremental polls.
  const latestTsRef = useRef<number | null>(null)

  const load = useCallback(async (incremental: boolean) => {
    const id = ++reqId.current
    const since = incremental ? latestTsRef.current : null
    const r = await fetchSwarmTraces(since)
    // Ignore this response if a newer request has started, or if the
    // component has unmounted.
    if (id !== reqId.current || !mounted.current) return

    if (since != null) {
      setTraces((prev) => {
        if (r.traces.length === 0) return prev
        const seen = new Set(prev.map((t) => t.id))
        const fresh = r.traces.filter((t) => !seen.has(t.id))
        return fresh.length > 0 ? [...fresh, ...prev] : prev
      })
      // `truncated` reflects the full 500-row page, not a small incremental
      // page — leave it as whatever the last full load reported.
    } else {
      setTraces(r.traces)
      setTruncated(r.truncated)
    }

    for (const t of r.traces) {
      const ts = new Date(t.timestamp).getTime()
      if (Number.isFinite(ts) && (latestTsRef.current == null || ts > latestTsRef.current)) {
        latestTsRef.current = ts
      }
    }
    setLoading(false)
  }, [])

  // Initial full load with unmount guard.
  useEffect(() => {
    mounted.current = true
    load(false)
    return () => { mounted.current = false }
  }, [load])

  // Re-fetch immediately (incrementally) whenever isLive flips back to true,
  // so the user sees fresh data right away instead of waiting up to pollMs.
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (isLive && !wasLive.current) load(true)
    wasLive.current = isLive
  }, [isLive, load])

  useVisibleInterval(() => load(true), pollMs, isLive)

  return { traces, truncated, loading, isLive, toggleLive: () => setIsLive((v) => !v) }
}
