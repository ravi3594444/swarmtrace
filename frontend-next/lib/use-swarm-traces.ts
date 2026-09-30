'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Trace } from './trace-types'
import { fetchSwarmTraces } from './swarm-api'
import { useVisibleInterval } from '@/hooks/use-visible-interval'

/**
 * Backs the Traces page. After the first full load, polls pass `since` = the
 * newest timestamp held, and new rows are merged (deduped by id) into the
 * list. Polling pauses while the tab is hidden (useVisibleInterval).
 * `truncated` lets the page show <TruncationBanner /> when the backend hit
 * the 500-row cap.
 */
export function useSwarmTraces(pollMs = 8000) {
  const [traces, setTraces] = useState<Trace[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(true)
  // reqId drops stale responses that resolve after a newer request;
  // cancelled skips state updates after unmount.
  const reqId = useRef(0)
  const mounted = useRef(true)
  // Newest trace timestamp (epoch ms) held so far; null until the first
  // full load. Drives `since` on incremental polls.
  const latestTsRef = useRef<number | null>(null)

  const load = useCallback(async (incremental: boolean) => {
    const id = ++reqId.current
    const since = incremental ? latestTsRef.current : null
    const r = await fetchSwarmTraces(since)
    // ignore if a newer request started or we've unmounted
    if (id !== reqId.current || !mounted.current) return

    if (since != null) {
      setTraces((prev) => {
        if (r.traces.length === 0) return prev
        const seen = new Set(prev.map((t) => t.id))
        const fresh = r.traces.filter((t) => !seen.has(t.id))
        return fresh.length > 0 ? [...fresh, ...prev] : prev
      })
      // truncated describes the full 500-row page, so leave it as the last
      // full load set it
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

  // Initial full load
  useEffect(() => {
    mounted.current = true
    load(false)
    return () => { mounted.current = false }
  }, [load])

  // Re-fetch incrementally as soon as isLive flips back to true.
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (isLive && !wasLive.current) load(true)
    wasLive.current = isLive
  }, [isLive, load])

  useVisibleInterval(() => load(true), pollMs, isLive)

  return { traces, truncated, loading, isLive, toggleLive: () => setIsLive((v) => !v) }
}
