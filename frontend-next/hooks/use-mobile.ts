import * as React from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Start undefined (not window-derived) to avoid an SSR hydration mismatch;
  // the real value is set after mount.
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    // set the initial value in a rAF so setState isn't synchronous in the effect body
    const raf = requestAnimationFrame(() => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    })
    return () => {
      mql.removeEventListener('change', onChange)
      cancelAnimationFrame(raf)
    }
  }, [])

  return !!isMobile
}
