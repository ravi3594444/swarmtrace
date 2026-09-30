'use client'

import { toast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'

// Surfaces fetch failures from lib/api.ts (expired session, backend down)
// instead of letting them look like an empty dashboard. Throttled to one
// toast per window since pages fire several fetches in parallel.
const THROTTLE_MS = 8000
let lastShownAt = 0

// Retry callbacks: the caller registers one on failure and "Retry now" in
// the toast calls the latest. A global registry is enough since only one
// toast shows at a time.
let lastRetryFn: (() => void) | null = null

export function reportFetchError(context: string, retryFn?: () => void) {
  // last failure wins
  if (retryFn) lastRetryFn = retryFn

  const now = Date.now()
  if (now - lastShownAt < THROTTLE_MS) return
  lastShownAt = now

  toast({
    variant: 'destructive',
    title: 'Connection issue',
    description: `Couldn't reach ${context}. Data shown may be stale.`,
    action: lastRetryFn ? (
      <ToastAction
        altText="Retry now"
        onClick={() => {
          const fn = lastRetryFn
          lastRetryFn = null
          lastShownAt = 0  // reset the throttle so a repeat failure can toast again
          if (fn) fn()
        }}
      >
        Retry now
      </ToastAction>
    ) : undefined,
  })
}
