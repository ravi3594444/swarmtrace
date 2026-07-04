import * as React from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Start as undefined (NOT a lazy initializer that reads window) to avoid
  // SSR hydration mismatches — server renders false, client might render
  // true on a mobile device. The actual value is set after mount.
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    // Defer the initial setState via requestAnimationFrame so it's not
    // synchronous in the effect body (avoids cascading-render lint
    // violation). The RAF callback runs after the effect's body.
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
