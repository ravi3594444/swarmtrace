'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Trace } from './trace-types'
import { fetchSwarmTraces } from './swarm-api'

/**
 * Hook backing the Traces page.
 *
 * Returns `truncated` (audit finding #4 follow-up) so the page can render
 * <TruncationBanner /> when the backend capped the result at 500 rows.
 * Previously the hook returned only `{ traces, loading, isLive, toggleLive }`
 * and the `truncated` flag from /api/traces was dropped at the lib/swarm-api.ts
 * layer — the backend was computing it but no client ever saw it.
 */
export function useSwarmTraces(pollMs = 8000) {
  const [traces, setTraces] = useState<Trace[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(true)
  const interval = useRef<ReturnType<typeof setInterval> | null>(null)
  // Monotonic request ID + cancelled flag — guards against two race conditions:
  //   1. A slow in-flight request resolving AFTER a newer one (stale data
  //      overwrites fresh). reqId lets us ignore the stale response.
  //   2. The initial fetch resolving after the component unmounts (React
  //      state update on unmounted component). cancelled lets us skip it.
  const reqId = useRef(0)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    const id = ++reqId.current
    const r = await fetchSwarmTraces()
    // Ignore this response if a newer request has started, or if the
    // component has unmounted.
    if (id !== reqId.current || !mounted.current) return
    setTraces(r.traces)
    setTruncated(r.truncated)
    setLoading(false)
  }, [])

  // Initial load with unmount guard.
  useEffect(() => {
    mounted.current = true
    load()
    return () => { mounted.current = false }
  }, [load])

  // Polling — also loads immediately when isLive flips to true, so the
  // user sees fresh data right away instead of waiting up to pollMs.
  useEffect(() => {
    if (interval.current) clearInterval(interval.current)
    if (isLive) {
      load()
      interval.current = setInterval(load, pollMs)
    }
    return () => { if (interval.current) clearInterval(interval.current) }
  }, [isLive, load, pollMs])

  return { traces, truncated, loading, isLive, toggleLive: () => setIsLive((v) => !v) }
}
