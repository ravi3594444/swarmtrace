import { toast } from '@/hooks/use-toast'

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

export function reportFetchError(context: string) {
  const now = Date.now()
  if (now - lastShownAt < THROTTLE_MS) return
  lastShownAt = now
  toast({
    variant: 'destructive',
    title: 'Connection issue',
    description: `Couldn't reach ${context}. Data shown may be stale — retrying automatically.`,
  })
}
