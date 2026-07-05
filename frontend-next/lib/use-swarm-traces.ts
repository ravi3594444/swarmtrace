'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Trace } from './trace-types'
import { fetchSwarmTraces } from './swarm-api'

export function useSwarmTraces(pollMs = 8000) {
  const [traces, setTraces] = useState<Trace[]>([])
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
    setTraces(r)
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

  return { traces, loading, isLive, toggleLive: () => setIsLive((v) => !v) }
}
