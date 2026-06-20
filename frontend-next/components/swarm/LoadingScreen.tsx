'use client'

import { DotLottieReact } from '@lottiefiles/dotlottie-react'

export function SwarmLoadingScreen({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[320px] py-12 gap-4 fade-slide-in">
      <DotLottieReact
        src="/loading.lottie"
        autoplay
        loop
        style={{ width: 140, height: 140 }}
      />
      <p className="text-sm text-muted-foreground font-mono tracking-wider uppercase">
        {message}
      </p>
    </div>
  )
}
