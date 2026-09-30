'use client'

import { useSyncExternalStore } from 'react'
import { DotLottieReact } from '@lottiefiles/dotlottie-react'
import { DotLottie } from '@lottiefiles/dotlottie-web'

// Point the renderer at our self-hosted WASM so it never hits cdn.jsdelivr.net
// (which would be blocked by connect-src CSP)
DotLottie.setWasmUrl('/dotlottie-player.wasm')

// prefers-reduced-motion via useSyncExternalStore; server snapshot is false.
const reducedMotionSubscribe = (cb: () => void) => {
  if (typeof window === 'undefined') return () => {}
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const reducedMotionSnapshot = () => {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
const reducedMotionServerSnapshot = () => false

export function SwarmLoadingScreen({ message = 'Loading...' }: { message?: string }) {
  const reducedMotion = useSyncExternalStore(
    reducedMotionSubscribe,
    reducedMotionSnapshot,
    reducedMotionServerSnapshot,
  )

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[320px] py-12 gap-4 fade-slide-in">
      <DotLottieReact
        src="/loading.lottie"
        autoplay={!reducedMotion}
        loop={!reducedMotion}
        style={{ width: 140, height: 140 }}
      />
      <p className="text-sm text-muted-foreground font-mono tracking-wider uppercase">
        {message}
      </p>
    </div>
  )
}
