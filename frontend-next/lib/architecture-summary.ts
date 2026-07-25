import type { Trace } from './trace-types'

export type TraceKind = NonNullable<Trace['kind']>

export type ArchitectureComponent = {
  name: string
  calls: number
  errors: number
  latency: number
  tokens: number
  cost: number
  latestMs: number
  representative: Trace
}

export type ArchitectureLayer = {
  kind: TraceKind
  label: string
  description: string
  spans: number
  errors: number
  latency: number
  tokens: number
  cost: number
  components: ArchitectureComponent[]
}

export type ArchitectureEdge = {
  from: TraceKind
  to: TraceKind
  count: number
  errors: number
}

export type ArchitectureSummary = {
  roots: Trace[]
  linked: number
  orphaned: number
  totalTokens: number
  totalCost: number
  totalErrors: number
}

export const KIND_ORDER: TraceKind[] = ['agent', 'llm', 'tool', 'retrieval', 'function']

export const KIND_LABELS: Record<TraceKind, { label: string; description: string }> = {
  agent: { label: 'Agents', description: 'Root and sub-agent runs' },
  llm: { label: 'LLM', description: 'Model calls and token usage' },
  tool: { label: 'Tools', description: 'External actions and MCP tools' },
  retrieval: { label: 'Retrieval', description: 'Search, scraping, and RAG spans' },
  function: { label: 'Functions', description: 'Helpers and internal work' },
}

export function traceKind(t: Trace): TraceKind {
  return t.kind ?? 'function'
}

export function formatLatency(seconds: number): string {
  return seconds >= 1 ? `${seconds.toFixed(2)}s` : `${Math.round(seconds * 1000)}ms`
}

export function formatCost(cost: number): string {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(5)}`
}

export function buildArchitectureLayers(traces: Trace[]): ArchitectureLayer[] {
  return KIND_ORDER.map((kind) => {
    const spans = traces.filter((t) => traceKind(t) === kind)
    const componentMap = new Map<string, ArchitectureComponent>()

    for (const span of spans) {
      const name = span.function || '(unnamed)'
      const current = componentMap.get(name)
      const tokens = (span.input_tokens ?? 0) + (span.output_tokens ?? 0)
      const latestMs = new Date(span.timestamp).getTime()
      if (!current) {
        componentMap.set(name, {
          name,
          calls: 1,
          errors: span.error ? 1 : 0,
          latency: span.latency_sec ?? 0,
          tokens,
          cost: span.cost_usd ?? 0,
          latestMs,
          representative: span,
        })
      } else {
        current.calls += 1
        current.errors += span.error ? 1 : 0
        current.latency += span.latency_sec ?? 0
        current.tokens += tokens
        current.cost += span.cost_usd ?? 0
        if (latestMs > current.latestMs) {
          current.latestMs = latestMs
          current.representative = span
        }
      }
    }

    const meta = KIND_LABELS[kind]
    return {
      kind,
      label: meta.label,
      description: meta.description,
      spans: spans.length,
      errors: spans.filter((t) => t.error).length,
      latency: spans.reduce((sum, t) => sum + (t.latency_sec ?? 0), 0),
      tokens: spans.reduce((sum, t) => sum + (t.input_tokens ?? 0) + (t.output_tokens ?? 0), 0),
      cost: spans.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0),
      components: Array.from(componentMap.values())
        .sort((a, b) => b.calls - a.calls || b.latestMs - a.latestMs)
        .slice(0, 5),
    }
  })
}

export function buildArchitectureEdges(traces: Trace[]): ArchitectureEdge[] {
  const byId = new Map(traces.map((t) => [t.id, t]))
  const edgeMap = new Map<string, ArchitectureEdge>()

  for (const child of traces) {
    if (!child.parent_id) continue
    const parent = byId.get(child.parent_id)
    if (!parent) continue
    const from = traceKind(parent)
    const to = traceKind(child)
    const key = `${from}->${to}`
    const edge = edgeMap.get(key) || { from, to, count: 0, errors: 0 }
    edge.count += 1
    edge.errors += child.error ? 1 : 0
    edgeMap.set(key, edge)
  }

  return Array.from(edgeMap.values()).sort((a, b) => b.count - a.count).slice(0, 8)
}

export function summarizeArchitecture(traces: Trace[]): ArchitectureSummary {
  const traceIds = new Set(traces.map((t) => t.id))
  const roots = traces.filter((t) => !t.parent_id)
  const linked = traces.filter((t) => t.parent_id && traceIds.has(t.parent_id)).length

  return {
    roots,
    linked,
    orphaned: Math.max(0, traces.length - roots.length - linked),
    totalTokens: traces.reduce((sum, t) => sum + (t.input_tokens ?? 0) + (t.output_tokens ?? 0), 0),
    totalCost: traces.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0),
    totalErrors: traces.filter((t) => t.error).length,
  }
}
