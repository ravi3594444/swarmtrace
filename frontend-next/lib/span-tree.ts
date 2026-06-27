import type { Trace } from './trace-types'

export type SpanNode = Trace & { children: SpanNode[] }

export function buildSpanTree(traces: Trace[]): SpanNode[] {
  const map = new Map<string, SpanNode>()
  traces.forEach((t) => map.set(t.id, { ...t, children: [] }))

  const roots: SpanNode[] = []
  map.forEach((node) => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  })

  // Sort children by timestamp ascending, roots by timestamp descending
  map.forEach((node) =>
    node.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  )
  roots.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  return roots
}

export function countDescendants(node: SpanNode): number {
  return node.children.reduce((s, c) => s + 1 + countDescendants(c), 0)
}

export function hasTreeError(node: SpanNode): boolean {
  return !!node.error || node.children.some(hasTreeError)
}
