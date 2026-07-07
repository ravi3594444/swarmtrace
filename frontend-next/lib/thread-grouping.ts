import type { Trace } from './trace-types'

export type Thread = {
  sessionId: string
  traces: Trace[]
  turnCount: number
  totalCost: number
  totalTokens: number
  hasError: boolean
  firstSeen: string
  lastSeen: string
}

function timeValue(trace: Trace): number {
  const value = Date.parse(trace.timestamp)
  return Number.isFinite(value) ? value : 0
}

function timeValueString(timestamp: string): number {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : 0
}

export function groupThreads(traces: Trace[]): Thread[] {
  const buckets = new Map<string, Trace[]>()

  for (const trace of traces) {
    if (!trace.session_id) continue
    const list = buckets.get(trace.session_id) ?? []
    list.push(trace)
    buckets.set(trace.session_id, list)
  }

  return Array.from(buckets.entries())
    .map(([sessionId, sessionTraces]) => {
      const sorted = [...sessionTraces].sort((a, b) => {
        const delta = timeValue(a) - timeValue(b)
        return delta !== 0 ? delta : a.id.localeCompare(b.id)
      })

      return {
        sessionId,
        traces: sorted,
        turnCount: sorted.length,
        totalCost: sorted.reduce((sum, trace) => sum + (trace.cost_usd ?? 0), 0),
        totalTokens: sorted.reduce((sum, trace) => sum + (trace.input_tokens ?? 0) + (trace.output_tokens ?? 0), 0),
        hasError: sorted.some((trace) => Boolean(trace.error)),
        firstSeen: sorted[0]?.timestamp ?? '',
        lastSeen: sorted[sorted.length - 1]?.timestamp ?? '',
      }
    })
    .sort((a, b) => {
      const delta = timeValueString(b.lastSeen) - timeValueString(a.lastSeen)
      return delta !== 0 ? delta : a.sessionId.localeCompare(b.sessionId)
    })
}
