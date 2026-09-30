'use client'

import { useEffect, useRef } from 'react'

/**
 * setInterval that skips ticks while the tab is hidden and fires one
 * catch-up call when it becomes visible again. `enabled=false` turns off the
 * interval and the visibility listener.
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
