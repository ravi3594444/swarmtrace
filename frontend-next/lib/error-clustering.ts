import type { Trace } from './trace-types'

export type ErrorCluster = {
  /** Stable key derived from the normalized error signature. */
  signature: string
  /** Exception class / type (text before the first colon), e.g. "ValueError". */
  type: string
  /** A representative raw error message for display. */
  sample: string
  /** Number of errored spans in this cluster. */
  count: number
  /** Distinct function names that produced this error, most frequent first. */
  functions: string[]
  /** Most recent timestamp (ISO) across the cluster's traces. */
  lastSeen: string
  /** The errored traces in this cluster, newest first. */
  traces: Trace[]
}

/**
 * Collapse an error message down to a stable signature so that the same bug
 * — which produces messages differing only in ids, numbers, paths, hex
 * addresses or quoted values — clusters into a single group instead of N
 * near-identical rows.
 *
 * The exception type (text before the first colon) is preserved verbatim;
 * only the message body is normalized.
 */
export function errorSignature(error: string): { type: string; signature: string } {
  const trimmed = error.trim()
  const colon = trimmed.indexOf(':')
  const hasType = colon > 0 && /^[A-Za-z_][\w.]*$/.test(trimmed.slice(0, colon))
  const type = hasType ? trimmed.slice(0, colon).trim() : 'Error'
  const body = hasType ? trimmed.slice(colon + 1) : trimmed

  const normalizedBody = body
    .replace(/0x[0-9a-fA-F]+/g, '<addr>')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '<hash>')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '<str>')
    .replace(/(?:\/[\w.\-]+)+\/?/g, '<path>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  return { type, signature: `${type}|${normalizedBody}` }
}

/**
 * Group errored traces by their normalized signature. Non-errored traces are
 * ignored. Clusters are returned largest-first (ties broken by most recent).
 */
export function clusterErrors(traces: Trace[]): ErrorCluster[] {
  const groups = new Map<string, { type: string; traces: Trace[]; funcs: Map<string, number> }>()

  for (const t of traces) {
    if (!t.error) continue
    const { type, signature } = errorSignature(t.error)
    let g = groups.get(signature)
    if (!g) {
      g = { type, traces: [], funcs: new Map() }
      groups.set(signature, g)
    }
    g.traces.push(t)
    g.funcs.set(t.function, (g.funcs.get(t.function) ?? 0) + 1)
  }

  const clusters: ErrorCluster[] = []
  for (const [signature, g] of groups) {
    const sorted = [...g.traces].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const functions = [...g.funcs.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    clusters.push({
      signature,
      type: g.type,
      sample: sorted[0]?.error ?? '',
      count: sorted.length,
      functions,
      lastSeen: sorted[0]?.timestamp ?? '',
      traces: sorted,
    })
  }

  return clusters.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
}
