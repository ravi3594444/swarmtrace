'use client'

import { toast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'

// Every helper in lib/api.ts used to swallow fetch failures and return
// `null`, which every hook then defaulted to an empty array/object. That
// made a broken request (expired session, backend down, network drop)
// render identically to "you genuinely have no data" — no error, no retry,
// just a quietly empty dashboard. This surfaces those failures instead.
//
// Throttled to one toast per window: pages like /overview fire several
// fetches in parallel, and if they fail together (e.g. session expired)
// we don't want to fire a toast per request.
const THROTTLE_MS = 8000
let lastShownAt = 0

// Registry of retry callbacks — when a fetch fails, the caller can register
// a retry function. If the user clicks "Retry now" in the toast, we call
// the most recently registered callback. This is a simple global registry
// rather than per-toast because the throttle means only one toast shows.
let lastRetryFn: (() => void) | null = null

export function reportFetchError(context: string, retryFn?: () => void) {
  // Register the retry callback (replaces any previous one — last failure wins)
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
          lastShownAt = 0  // reset throttle so a new toast can show if retry also fails
          if (fn) fn()
        }}
      >
        Retry now
      </ToastAction>
    ) : undefined,
  })
}
