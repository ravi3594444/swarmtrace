'use client'

import { useEffect, useRef } from 'react'

/**
 * Runs `callback` on a `setInterval(ms)` cadence, but skips any tick that
 * fires while the tab is hidden (`document.visibilityState === 'hidden'`)
 * and fires one immediate catch-up call as soon as the tab becomes visible
 * again.
 *
 * Audit finding: none of the dashboard's data pollers (traces, agent
 * graph, overview, agents) paused on backgrounded tabs — an open-but-hidden
 * tab kept polling all night, at whatever cost the poll carries.
 *
 * `enabled=false` disables both the interval and the visibility listener
 * entirely (used for the isLive/pause toggle already present on these
 * hooks).
 */
export function useVisibleInterval(
  callback: () => void,
  ms: number,
  enabled: boolean = true,
) {
  const savedCallback = useRef(callback)

  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  useEffect(() => {
    if (!enabled) return

    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      savedCallback.current()
    }, ms)

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        savedCallback.current()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms, enabled])
}
