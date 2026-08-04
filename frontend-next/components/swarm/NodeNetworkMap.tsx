'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Flame,
  Info,
  Move,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Shuffle,
  SlidersHorizontal,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { formatRelativeTime } from '@/lib/api'
import type {
  AgentGraphEdge,
  AgentGraphNode,
  AgentNetworkGraph,
  CollaborationMode,
} from '@/lib/agent-network'

const WIDTH = 1280
const HEIGHT = 760

/* Charcoal & Ivory Monochrome — see
   stitch_swarmtrace_developer_dashboard/charcoal_ivory_monochrome/DESIGN.md
   Collaboration mode is communicated through *tonal layering* (brightness /
   opacity), not hue — the design system is strictly achromatic. The only
   hues on this screen are the pre-existing app-wide status colors (emerald
   = live/running, amber = warning/partial, error-red = failed), kept
   because they match how status is already color-coded everywhere else in
   the dashboard. Everything else — nodes, edges, backgrounds, chrome — is
   grayscale. */
const ERROR_COLOR = '#ffb4ab' // DESIGN.md `error` token

type DecoratedNode = AgentGraphNode & {
  r: number
  color: string
  heat: number
}

type PositionedNode = DecoratedNode & {
  x: number
  y: number
}

type PositionedEdge = AgentGraphEdge & {
  sourceNode: PositionedNode
  targetNode: PositionedNode
}

type LayoutMode = 'force' | 'hierarchical'

// Node fill colors use CSS variables so they invert correctly between light
// and dark themes. Previously these were hardcoded hex (#ffffff, #e5e2e1,
// etc.) which made nodes invisible on a light background. The CSS vars are
// defined in globals.css :root and .dark, mapping to the same tonal ramp
// (primary brightest → outline dimmest) in each theme.
const MODE_STYLE: Record<CollaborationMode, { label: string; color: string; glow: string; target: { x: number; y: number } }> = {
  orchestrator: {
    label: 'Orchestrator',
    color: 'var(--network-node-primary, #ffffff)', // primary — brightest, most emphasis
    glow: 'var(--network-node-primary-glow, rgba(255, 255, 255, 0.55))',
    target: { x: WIDTH * 0.48, y: HEIGHT * 0.44 },
  },
  sub_agent: {
    label: 'Sub-agent',
    color: 'var(--network-node-on-surface, #e5e2e1)', // on-surface
    glow: 'var(--network-node-on-surface-glow, rgba(229, 226, 225, 0.45))',
    target: { x: WIDTH * 0.58, y: HEIGHT * 0.54 },
  },
  peer: {
    label: 'Peer',
    color: 'var(--network-node-on-surface-variant, #c4c7c8)', // on-surface-variant
    glow: 'var(--network-node-on-surface-variant-glow, rgba(196, 199, 200, 0.4))',
    target: { x: WIDTH * 0.38, y: HEIGHT * 0.56 },
  },
  solo: {
    label: 'Solo',
    color: 'var(--network-node-outline, #8e9192)', // outline — dimmest, least emphasis
    glow: 'var(--network-node-outline-glow, rgba(142, 145, 146, 0.32))',
    target: { x: WIDTH * 0.68, y: HEIGHT * 0.36 },
  },
}

function hashNumber(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function jitter(seed: number, amount: number) {
  return ((seed % 1000) / 1000 - 0.5) * amount
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function nodeRadius(node: AgentGraphNode): number {
  return clamp(8 + Math.sqrt(Math.max(node.spans, 1)) * 2.1 + Math.log2(node.runs + 1) * 2, 9, 28)
}

function nodeHeat(node: AgentGraphNode): number {
  return Math.log1p(node.tokens / 300 + node.cost * 120 + node.errors * 6 + node.ragSpans * 3)
}

function decorateNodes(graph: AgentNetworkGraph): DecoratedNode[] {
  return graph.nodes.map((node) => {
    const style = MODE_STYLE[node.collaborationMode]
    return {
      ...node,
      r: nodeRadius(node),
      color: node.errors > 0 ? ERROR_COLOR : style.color,
      heat: nodeHeat(node),
    }
  })
}

// Force-directed layout — the original physics simulation. Good at showing
// overall graph "shape" (clusters, density) but doesn't communicate call
// order/direction on its own; that's what the arrowheads on edges are for.
function forceLayout(decorated: DecoratedNode[], edgeList: AgentGraphEdge[]): PositionedNode[] {
  const nodes: PositionedNode[] = decorated.map((node, index) => {
    const seed = hashNumber(node.id)
    const style = MODE_STYLE[node.collaborationMode]
    const angle = ((seed % 360) / 180) * Math.PI
    const ring = 80 + (index % 9) * 26 + (seed % 80)
    return {
      ...node,
      x: style.target.x + Math.cos(angle) * ring + jitter(seed, 70),
      y: style.target.y + Math.sin(angle) * ring + jitter(seed >> 8, 70),
    }
  })

  const indexById = new Map(nodes.map((node, index) => [node.id, index]))
  const velocities = nodes.map(() => ({ x: 0, y: 0 }))

  // Iteration count scales down for large graphs to keep the layout
  // responsive. 150 iterations of O(n²) repulsion is fine for ~30 nodes
  // but janks at 100+. For larger graphs we reduce iterations — the
  // layout is slightly less converged but still visually correct, and
  // the main thread stays responsive. A web worker would be the ideal
  // fix but requires bundler setup; this adaptive approach is a pragmatic
  // middle ground that prevents the UI from freezing.
  const iterations = nodes.length > 80 ? 50 : nodes.length > 40 ? 100 : 150

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const distSq = Math.max(dx * dx + dy * dy, 80)
        const dist = Math.sqrt(distSq)
        const force = (a.r + b.r + 90) * 9 / distSq
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        velocities[i].x -= fx
        velocities[i].y -= fy
        velocities[j].x += fx
        velocities[j].y += fy
      }
    }

    for (const edge of edgeList) {
      const s = indexById.get(edge.source)
      const t = indexById.get(edge.target)
      if (s == null || t == null) continue
      const a = nodes[s]
      const b = nodes[t]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const desired = edge.relation === 'orchestrates' ? 170 : 125
      const strength = edge.relation === 'orchestrates' ? 0.018 : 0.012
      const force = (dist - desired) * strength
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      velocities[s].x += fx
      velocities[s].y += fy
      velocities[t].x -= fx
      velocities[t].y -= fy
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      const target = MODE_STYLE[node.collaborationMode].target
      velocities[i].x += (target.x - node.x) * 0.006
      velocities[i].y += (target.y - node.y) * 0.006
      node.x = clamp(node.x + velocities[i].x, 54, WIDTH - 54)
      node.y = clamp(node.y + velocities[i].y, 54, HEIGHT - 54)
      velocities[i].x *= 0.78
      velocities[i].y *= 0.78
    }
  }

  return nodes
}

// Hierarchical (tree) layout — depth is derived from "orchestrates" edges
// via BFS from root orchestrators, so orchestrator → sub-agent call order
// reads top-to-bottom, matching how LangSmith/Langfuse lay out agent
// graphs. Nodes with no incoming "orchestrates" edge (orchestrators,
// solo agents, peer-only agents) become roots at depth 0. Peer edges don't
// affect depth — they're drawn wherever their endpoints land.
function hierarchicalLayout(decorated: DecoratedNode[], edgeList: AgentGraphEdge[]): PositionedNode[] {
  const byId = new Map(decorated.map((node) => [node.id, node]))
  const children = new Map<string, string[]>()
  const hasIncoming = new Set<string>()
  for (const edge of edgeList) {
    if (edge.relation !== 'orchestrates') continue
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const list = children.get(edge.source) ?? []
    list.push(edge.target)
    children.set(edge.source, list)
    hasIncoming.add(edge.target)
  }

  const depth = new Map<string, number>()
  const queue: string[] = []
  for (const node of decorated) {
    if (!hasIncoming.has(node.id)) {
      depth.set(node.id, 0)
      queue.push(node.id)
    }
  }
  while (queue.length > 0) {
    const id = queue.shift() as string
    const d = depth.get(id) ?? 0
    for (const childId of children.get(id) ?? []) {
      // A node can be reached via multiple orchestrators; keep the
      // shallowest depth so the tree stays compact and cycles can't loop.
      if (depth.has(childId) && (depth.get(childId) as number) <= d + 1) continue
      depth.set(childId, d + 1)
      queue.push(childId)
    }
  }
  // Anything unreached (shouldn't normally happen) falls back to depth 0.
  for (const node of decorated) {
    if (!depth.has(node.id)) depth.set(node.id, 0)
  }

  const modeRank: Record<CollaborationMode, number> = { orchestrator: 0, sub_agent: 1, peer: 2, solo: 3 }
  const byDepth = new Map<number, DecoratedNode[]>()
  for (const node of decorated) {
    const d = depth.get(node.id) as number
    const list = byDepth.get(d) ?? []
    list.push(node)
    byDepth.set(d, list)
  }

  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b)
  const maxDepth = depths.length > 0 ? depths[depths.length - 1] : 0
  const topMargin = 90
  const rowGap = maxDepth > 0 ? (HEIGHT - topMargin - 90) / maxDepth : 0

  const positioned: PositionedNode[] = []
  for (const d of depths) {
    const row = (byDepth.get(d) as DecoratedNode[]).sort(
      (a, b) => modeRank[a.collaborationMode] - modeRank[b.collaborationMode] || a.id.localeCompare(b.id),
    )
    const colGap = WIDTH / (row.length + 1)
    row.forEach((node, i) => {
      positioned.push({ ...node, x: colGap * (i + 1), y: topMargin + d * rowGap })
    })
  }
  return positioned
}

function layoutGraph(graph: AgentNetworkGraph, mode: LayoutMode): { nodes: PositionedNode[]; edges: PositionedEdge[] } {
  const decorated = decorateNodes(graph)
  const nodes = mode === 'hierarchical'
    ? hierarchicalLayout(decorated, graph.edges)
    : forceLayout(decorated, graph.edges)

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges: PositionedEdge[] = graph.edges
    .map((edge) => {
      const sourceNode = byId.get(edge.source)
      const targetNode = byId.get(edge.target)
      if (!sourceNode || !targetNode) return null
      return { ...edge, sourceNode, targetNode }
    })
    .filter(Boolean) as PositionedEdge[]

  return { nodes, edges }
}

// Trims a point along the source→target line by `margin` so edges stop at
// a node's visual boundary (plus arrowhead clearance) instead of running
// into its center and disappearing under the circle.
function trimToward(from: { x: number; y: number }, to: { x: number; y: number }, margin: number) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
  const t = Math.max(dist - margin, 0) / dist
  return { x: from.x + dx * t, y: from.y + dy * t }
}

function formatCost(cost: number) {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(5)}`
}

function formatMode(mode: CollaborationMode) {
  return MODE_STYLE[mode].label
}

function modePillClass(mode: CollaborationMode) {
  if (mode === 'orchestrator') return 'border-primary/50 bg-primary/15 text-foreground'
  if (mode === 'sub_agent') return 'border-on-surface-variant/40 bg-on-surface-variant/10 text-foreground'
  if (mode === 'peer') return 'border-outline/40 bg-outline/10 text-on-surface-variant'
  return 'border-outline-variant/60 bg-outline-variant/10 text-muted-foreground'
}

function EmptyNetwork() {
  return (
    <div className="flex min-h-[620px] items-center justify-center rounded-[2rem] border border-border bg-card text-center">
      <div className="max-w-md px-8">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-secondary">
          <Radio className="h-7 w-7 text-foreground" />
        </div>
        <h2 className="text-2xl font-semibold text-foreground">No agent network yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Run agents with <code className="rounded bg-muted/50 px-1 py-0.5 text-foreground">@observe</code>,
          nested sub-agents, tools, or retrieval spans. SwarmTrace will draw the live collaboration map here.
        </p>
      </div>
    </div>
  )
}

export function NodeNetworkMap({
  graph,
  isLive,
  truncated,
  onToggleLive,
  onRefresh,
}: {
  graph: AgentNetworkGraph
  isLive: boolean
  truncated: boolean
  onToggleLive: () => void
  onRefresh: () => void
}) {
  // Layout is computed asynchronously via requestIdleCallback so the initial
  // render (which includes the SVG container + controls) isn't blocked by
  // the O(n²) force simulation. For large graphs this keeps the page
  // responsive — the map shows a "Layouting…" state for a frame, then
  // snaps to the laid-out nodes. For small graphs (<30 nodes) the layout
  // is fast enough that the loading state is never visible.
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('force')
  const [layout, setLayout] = useState<{ nodes: PositionedNode[]; edges: PositionedEdge[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    // requestIdleCallback isn't available in all environments (older
    // browsers, SSR). Fall back to setTimeout(0) which yields to the
    // event loop without the idle-cooperative scheduling.
    const ric = typeof window !== 'undefined' && 'requestIdleCallback' in window
      ? (window as Window).requestIdleCallback
      : (cb: () => void) => setTimeout(cb, 0)
    const handle = ric(() => {
      if (cancelled) return
      setLayout(layoutGraph(graph, layoutMode))
    })
    return () => {
      cancelled = true
      // requestIdleCallback returns a number (like setTimeout); cancel via
      // cancelIdleCallback when available, otherwise clearTimeout.
      if (typeof handle === 'number') {
        const cic = typeof window !== 'undefined' && 'cancelIdleCallback' in window
          ? (window as Window).cancelIdleCallback
          : clearTimeout
        cic(handle)
      }
    }
  }, [graph, layoutMode])

  const { nodes, edges } = layout ?? { nodes: [], edges: [] }
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [showLines, setShowLines] = useState(true)
  const [showLegend, setShowLegend] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // Search matches are computed against the current node set and drive a
  // dim/highlight pass over the graph — the same visual language already
  // used for hover/selection, just triggered by typing instead of pointing.
  const trimmedQuery = searchQuery.trim().toLowerCase()
  const searchMatchIds = useMemo(() => {
    if (!trimmedQuery) return null
    return new Set(
      nodes
        .filter((node) => node.label.toLowerCase().includes(trimmedQuery) || node.id.toLowerCase().includes(trimmedQuery))
        .map((node) => node.id),
    )
  }, [nodes, trimmedQuery])

  // Auto-select behavior: when the user hasn't selected a node, `selected`
  // falls back to nodes[0] below — no effect needed. (Previously an effect
  // called setSelectedId(nodes[0].id) synchronously once nodes arrived,
  // which the React Compiler flagged as a cascading-render hazard; the
  // fallback makes it redundant AND preserves the user's selection across
  // graph refreshes, since an explicit selection always wins.)
  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0]
  const hovered = nodes.find((node) => node.id === hoveredId)
  const highlighted = hovered || selected
  const connectedIds = useMemo(() => {
    if (!highlighted) return new Set<string>()
    const ids = new Set<string>([highlighted.id])
    for (const edge of edges) {
      if (edge.source === highlighted.id) ids.add(edge.target)
      if (edge.target === highlighted.id) ids.add(edge.source)
    }
    return ids
  }, [edges, highlighted])

  // Distinguish "graph has no nodes" (real empty state) from "layout is
  // still computing" (loading). The layout runs in requestIdleCallback so
  // there's a brief window where `layout` is null even though the graph
  // has nodes — showing EmptyNetwork during that window would flash the
  // wrong message.
  if (graph.nodes.length === 0) return <EmptyNetwork />
  if (nodes.length === 0) {
    // Layout is computing — show the map container with a subtle
    // "Layouting…" indicator instead of blocking the render.
    return (
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative min-h-[720px] overflow-hidden rounded-[2rem] border border-border bg-background flex items-center justify-center">
          <p className="text-sm text-muted-foreground font-mono uppercase tracking-wider animate-pulse">
            Layouting…
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="relative min-h-[720px] overflow-hidden rounded-[2rem] border border-border bg-background shadow-[0_30px_100px_rgba(0,0,0,0.55)] dark:shadow-[0_30px_100px_rgba(0,0,0,0.55)]">
        {/* Achromatic vignette + grid — no blue/violet/cyan, brightness only.
            The gradient uses CSS variables so it adapts to light/dark theme.
            Previously this hardcoded #0e0e0e/#0a0a0a/#000 which made the map
            a dark island in light mode. */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,var(--network-vignette,rgba(255,255,255,0.06)),transparent_34%),radial-gradient(circle_at_78%_28%,var(--network-vignette,rgba(255,255,255,0.04)),transparent_24%),radial-gradient(circle_at_22%_72%,var(--network-vignette,rgba(255,255,255,0.05)),transparent_25%),linear-gradient(180deg,var(--network-bg-from,#0e0e0e),var(--network-bg-to,#0a0a0a)_52%,var(--network-bg-end,#000))]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(var(--network-grid,rgba(142,145,146,0.14))_1px,transparent_1px),linear-gradient(90deg,var(--network-grid,rgba(142,145,146,0.14))_1px,transparent_1px)] [background-size:34px_34px]" />
        <div className="absolute inset-0 opacity-25 [background-image:radial-gradient(circle_at_center,var(--network-center-glow,rgba(255,255,255,0.10))_0,transparent_34%)]" />

        <div className="absolute left-5 right-5 top-5 z-20 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">Node Network Map</h2>
              {/* Live/partial keep the app's existing status-color convention (emerald = live, amber = warning) */}
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-200">
                {isLive ? 'Live' : 'Paused'}
              </span>
              {truncated && (
                <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-200">
                  partial
                </span>
              )}
            </div>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Move className="h-4 w-4" /> Drag to pan · scroll to zoom · click any agent node
            </p>
            <div className="relative mt-3 w-60">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search agents…"
                aria-label="Search agents by name"
                className="w-full rounded-xl border border-border bg-muted/30 py-2 pl-8 pr-8 text-xs text-foreground placeholder:text-muted-foreground backdrop-blur-xl focus:border-primary/40 focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {searchMatchIds && (
                <div className="absolute left-0 top-full mt-1 text-[11px] text-muted-foreground">
                  {searchMatchIds.size === 0
                    ? 'No agents match'
                    : `${searchMatchIds.size} of ${nodes.length} agent${searchMatchIds.size === 1 ? '' : 's'} match`}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-2xl border border-border bg-muted/40 p-1.5 backdrop-blur-xl">
              <button
                onClick={() => setLayoutMode('force')}
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  layoutMode === 'force' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
                title="Force-directed layout"
              >
                <Shuffle className="h-3.5 w-3.5" /> Force
              </button>
              <button
                onClick={() => setLayoutMode('hierarchical')}
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  layoutMode === 'hierarchical' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
                title="Hierarchical tree layout, ordered by orchestrator → sub-agent depth"
              >
                <Workflow className="h-3.5 w-3.5" /> Tree
              </button>
            </div>

            <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-1.5 backdrop-blur-xl">
              <button onClick={() => setZoom((z) => clamp(z + 0.12, 0.55, 2.2))} className="rounded-xl border border-border bg-muted/30 p-2 text-foreground hover:bg-muted/50" title="Zoom in">
                <ZoomIn className="h-4 w-4" />
              </button>
              <button onClick={() => setZoom((z) => clamp(z - 0.12, 0.55, 2.2))} className="rounded-xl border border-border bg-muted/30 p-2 text-foreground hover:bg-muted/50" title="Zoom out">
                <ZoomOut className="h-4 w-4" />
              </button>
              <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} className="rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/50">
                Reset
              </button>
              <button onClick={onRefresh} className="rounded-xl border border-border bg-muted/30 p-2 text-foreground hover:bg-muted/50" title="Refresh graph">
                <RefreshCw className="h-4 w-4" />
              </button>
              <button onClick={onToggleLive} className="rounded-xl border border-border bg-muted/30 p-2 text-foreground hover:bg-muted/50" title={isLive ? 'Pause live updates' : 'Resume live updates'}>
                {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="absolute right-6 top-32 z-20 space-y-3">
          <button
            onClick={() => setShowHeatmap((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showHeatmap ? 'border-primary/50 bg-primary/10 text-foreground ' : 'border-border bg-muted/40 text-muted-foreground'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
              <Flame className="h-4 w-4" />
            </span>
            Heatmap
          </button>
          <button
            onClick={() => setShowLines((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showLines ? 'border-primary/50 bg-primary/10 text-foreground ' : 'border-border bg-muted/40 text-muted-foreground'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            Connections
          </button>
          <button
            onClick={() => setShowLegend((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showLegend ? 'border-primary/50 bg-primary/10 text-foreground ' : 'border-border bg-muted/40 text-muted-foreground'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
              <Info className="h-4 w-4" />
            </span>
            Legend
          </button>

          {showLegend && (
            <div className="w-56 space-y-3 rounded-2xl border border-border bg-muted/40 p-4 text-[11px] leading-5 text-muted-foreground backdrop-blur-xl">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-foreground">Legend</div>
              <div className="space-y-1.5">
                {([
                  ['orchestrator', MODE_STYLE.orchestrator.color],
                  ['sub_agent', MODE_STYLE.sub_agent.color],
                  ['peer', MODE_STYLE.peer.color],
                  ['solo', MODE_STYLE.solo.color],
                ] as [CollaborationMode, string][]).map(([mode, color]) => (
                  <div key={mode} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    {formatMode(mode)}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ERROR_COLOR }} />
                  Has errors
                </div>
              </div>
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-emerald-400" /> Running now
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-primary" /> Uses RAG
                </div>
              </div>
              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="flex items-center gap-2">
                  <svg width="20" height="8" className="shrink-0"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--network-node-on-surface, #e5e2e1)" strokeWidth="2" /></svg>
                  Orchestrates →
                </div>
                <div className="flex items-center gap-2">
                  <svg width="20" height="8" className="shrink-0"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--network-node-outline, #8e9192)" strokeWidth="2" strokeDasharray="3 4" /></svg>
                  Peer hand-off →
                </div>
              </div>
            </div>
          )}
        </div>

        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
          onWheel={(event) => {
            event.preventDefault()
            setZoom((current) => clamp(current + (event.deltaY > 0 ? -0.08 : 0.08), 0.55, 2.2))
          }}
          onPointerDown={(event) => {
            dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!dragRef.current) return
            setPan({
              x: dragRef.current.panX + (event.clientX - dragRef.current.x) / zoom,
              y: dragRef.current.panY + (event.clientY - dragRef.current.y) / zoom,
            })
          }}
          onPointerUp={(event) => {
            dragRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
        >
          <defs>
            <filter id="nodeGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            {/* Heat encodes intensity via brightness, not a warm hue — stays achromatic */}
            <radialGradient id="heatGradient">
              <stop offset="0%" stopColor="var(--network-node-primary, #ffffff)" stopOpacity="0.32" />
              <stop offset="48%" stopColor="var(--network-node-on-surface, #e5e2e1)" stopOpacity="0.11" />
              <stop offset="100%" stopColor="var(--network-node-on-surface, #e5e2e1)" stopOpacity="0" />
            </radialGradient>
            {/* Arrowheads communicate call direction (orchestrator → sub-agent,
                earlier → later peer hand-off) — the one thing a pure
                force-directed "blob" layout can't show on its own. Separate
                active/dim variants per relation since a shared <marker> can't
                take per-line opacity, and opacity is how this achromatic
                design encodes emphasis. */}
            <marker id="arrow-orchestrate-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--network-node-on-surface, #e5e2e1)" fillOpacity="0.9" />
            </marker>
            <marker id="arrow-orchestrate-dim" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--network-node-on-surface, #e5e2e1)" fillOpacity="0.22" />
            </marker>
            <marker id="arrow-peer-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--network-node-outline, #8e9192)" fillOpacity="0.8" />
            </marker>
            <marker id="arrow-peer-dim" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--network-node-outline, #8e9192)" fillOpacity="0.2" />
            </marker>
          </defs>

          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {showHeatmap && nodes.map((node) => (
              <circle
                key={`heat-${node.id}`}
                cx={node.x}
                cy={node.y}
                r={node.r + node.heat * 18 + (node.ragSpans > 0 ? 14 : 0)}
                fill="url(#heatGradient)"
                opacity={0.35 + Math.min(node.heat / 8, 0.35)}
              />
            ))}

            {showLines && edges.map((edge) => {
              const isActive = connectedIds.has(edge.source) && connectedIds.has(edge.target)
              // orchestrates = brighter/solid (hierarchy), peer = dimmer/dashed (loose collaboration) — distinguished by tone + dash, not hue
              const stroke = edge.relation === 'orchestrates' ? 'var(--network-node-on-surface, #e5e2e1)' : 'var(--network-node-outline, #8e9192)'
              // Trim both ends so the line — and its arrowhead — stop at the
              // node's visual edge instead of running under the circle.
              const start = trimToward(edge.sourceNode, edge.targetNode, edge.sourceNode.r + 2)
              const end = trimToward(edge.targetNode, edge.sourceNode, edge.targetNode.r + 7)
              const marker = edge.relation === 'orchestrates'
                ? (isActive ? 'arrow-orchestrate-active' : 'arrow-orchestrate-dim')
                : (isActive ? 'arrow-peer-active' : 'arrow-peer-dim')
              return (
                <line
                  key={edge.id}
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  stroke={stroke}
                  strokeWidth={isActive ? 1.8 + Math.min(edge.calls, 6) * 0.15 : 0.8}
                  strokeOpacity={isActive ? 0.72 : 0.18}
                  strokeDasharray={edge.relation === 'peer' ? '4 7' : undefined}
                  markerEnd={`url(#${marker})`}
                />
              )
            })}

            {nodes.map((node, nodeIndex) => {
              const active = selected?.id === node.id
              const hoveredNode = hoveredId === node.id
              const dimmed = searchMatchIds
                ? !searchMatchIds.has(node.id)
                : Boolean(highlighted && !connectedIds.has(node.id))
              const style = MODE_STYLE[node.collaborationMode]
              return (
                <g
                  key={node.id}
                  opacity={dimmed ? 0.32 : 1}
                  // Keyboard accessibility: each node is a focusable button.
                  // Tab moves between nodes in layout order; Enter/Space
                  // selects; ArrowLeft/ArrowRight move to the previous/next
                  // node. aria-label describes the agent so screen readers
                  // can announce it. Previously this was mouse-only.
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.label}, ${formatMode(node.collaborationMode)}${node.ragSpans > 0 ? ', RAG' : ''}${node.status === 'RUNNING' ? ', running' : node.status === 'ERROR' ? ', error' : ''}, ${node.spans} spans, ${formatCost(node.cost)}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedId(node.id)
                    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                      event.preventDefault()
                      // Selection already wraps via modulo; focus must use the same
                      // wrapped index. parentElement.children mixes heat/edge/node
                      // siblings, so resolve focusable node elements by role instead
                      // of raw child index — otherwise wrap hits undefined and the
                      // focus ring sticks, trapping arrow nav at the boundary.
                      const delta = event.key === 'ArrowRight' ? 1 : -1
                      const nextIndex = (nodeIndex + delta + nodes.length) % nodes.length
                      setSelectedId(nodes[nextIndex].id)
                      const parent = event.currentTarget.parentElement
                      const nodeEls = parent
                        ? Array.from(parent.querySelectorAll<SVGElement>('[role="button"]'))
                        : []
                      nodeEls[nextIndex]?.focus?.()
                    }
                  }}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={(event) => { event.stopPropagation(); setSelectedId(node.id) }}
                  className="cursor-pointer focus-visible:outline-none"
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + 13}
                    fill={style.glow}
                    opacity={active || hoveredNode ? 0.42 : 0.16}
                    filter="url(#nodeGlow)"
                  />
                  {/* RUNNING ring keeps the app-wide emerald "live" convention */}
                  {node.status === 'RUNNING' && (
                    <circle cx={node.x} cy={node.y} r={node.r + 9} fill="none" stroke="#34d399" strokeOpacity="0.5" strokeWidth="1.4" />
                  )}
                  {/* RAG ring uses the primary accent — deliberately distinct from the
                      status-green ring above, since an agent can be RUNNING and RAG-using at once */}
                  {node.ragSpans > 0 && (
                    <circle cx={node.x} cy={node.y} r={node.r + 5} fill="none" stroke="var(--network-node-primary, #ffffff)" strokeOpacity="0.85" strokeWidth="2" />
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={node.color}
                    stroke={active ? 'var(--network-node-primary, #ffffff)' : node.errors > 0 ? '#ffdad6' : 'var(--network-node-outline, #8e9192)'}
                    strokeOpacity={active ? 0.95 : 0.55}
                    strokeWidth={active ? 2.5 : 1.2}
                    filter="url(#nodeGlow)"
                  />
                  <circle cx={node.x - node.r * 0.28} cy={node.y - node.r * 0.28} r={Math.max(2, node.r * 0.22)} fill="var(--network-node-primary, #ffffff)" opacity="0.55" />
                  {(active || hoveredNode || node.collaborationMode === 'orchestrator' || (searchMatchIds?.has(node.id) && searchMatchIds.size <= 12)) && (
                    <g>
                      <rect
                        x={node.x - 64}
                        y={node.y + node.r + 10}
                        width="128"
                        height="42"
                        rx="14"
                        fill="var(--network-label-bg, rgba(14, 14, 14, 0.85))"
                        stroke="var(--network-label-border, rgba(142, 145, 146, 0.3))"
                      />
                      <text x={node.x} y={node.y + node.r + 28} textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
                        {node.label.slice(0, 18)}
                      </text>
                      <text x={node.x} y={node.y + node.r + 43} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                        {formatMode(node.collaborationMode)}{node.ragSpans > 0 ? ' · RAG' : ''}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        <div className="absolute bottom-5 left-5 right-5 z-20 grid gap-3 md:grid-cols-4">
          {[
            { label: 'Agents', value: graph.summary.agents.toLocaleString() },
            { label: 'Connections', value: graph.summary.edges.toLocaleString() },
            { label: 'RAG agents', value: graph.summary.ragAgents.toLocaleString() },
            { label: 'Cost', value: formatCost(graph.summary.totalCost) },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-border bg-muted/40 px-4 py-3 backdrop-blur-xl">
              <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-muted-foreground">{item.label}</div>
              <div className="mt-1 font-mono text-xl font-bold text-foreground">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <aside className="rounded-[2rem] border border-border bg-card p-5 text-foreground shadow-[0_30px_100px_rgba(0,0,0,0.45)]">
        {selected && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.26em] text-muted-foreground">Selected Agent</div>
                <h3 className="mt-2 truncate text-2xl font-semibold text-foreground">{selected.label}</h3>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{selected.id}</p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${modePillClass(selected.collaborationMode)}`}>
                {formatMode(selected.collaborationMode)}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${selected.status === 'ERROR' ? 'border-destructive/50 bg-destructive/15 text-destructive-foreground' : selected.status === 'RUNNING' ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-200' : 'border-outline-variant/50 bg-outline-variant/10 text-muted-foreground'}`}>
                {selected.status}
              </span>
              {selected.ragSpans > 0 && (
                <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-foreground">
                  RAG · {selected.ragSpans}
                </span>
              )}
              {selected.errors > 0 && (
                <span className="rounded-full border border-destructive/50 bg-destructive/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive-foreground">
                  {selected.errors} errors
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Runs', value: selected.runs.toLocaleString() },
                { label: 'Spans', value: selected.spans.toLocaleString() },
                { label: 'Tokens', value: selected.tokens.toLocaleString() },
                { label: 'Cost', value: formatCost(selected.cost) },
                { label: 'LLM', value: selected.llmSpans.toLocaleString() },
                { label: 'Tools', value: selected.toolSpans.toLocaleString() },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl border border-border bg-muted/30 p-4">
                  <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{item.label}</div>
                  <div className="mt-1 font-mono text-lg font-bold text-foreground">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-border bg-muted/30 p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Last activity</div>
              <div className="mt-1 text-sm text-on-surface-variant">
                {selected.lastActive ? formatRelativeTime(selected.lastActive) : 'unknown'}
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted/50">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-outline via-on-surface-variant to-primary"
                  style={{ width: `${clamp((selected.spans / Math.max(...nodes.map((node) => node.spans), 1)) * 100, 8, 100)}%` }}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-muted/30 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Connections</div>
                <span className="text-xs text-muted-foreground">{edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length}</span>
              </div>
              <div className="space-y-2">
                {edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).slice(0, 8).map((edge) => {
                  const other = edge.source === selected.id ? edge.targetNode : edge.sourceNode
                  return (
                    <button
                      key={edge.id}
                      onClick={() => setSelectedId(other.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2 text-left transition hover:border-primary/30 hover:bg-primary/5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-foreground">{other.label}</div>
                        <div className="text-[11px] text-muted-foreground">{edge.relation} · {edge.calls} call{edge.calls === 1 ? '' : 's'}</div>
                      </div>
                      <span className={`h-2.5 w-2.5 rounded-full ${other.errors > 0 ? 'bg-destructive' : 'bg-foreground'}`} />
                    </button>
                  )
                })}
                {edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length === 0 && (
                  <div className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                    No collaboration edges for this agent in the current range.
                  </div>
                )}
              </div>
            </div>

            {/* Solid white CTA — DESIGN.md: "Primary buttons are solid white with black
                text... hover states reduce opacity to 90%" */}
            <Link
              href="/traces"
              className="block rounded-2xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground transition hover:opacity-90"
            >
              View trace details
            </Link>
          </div>
        )}
      </aside>
    </div>
  )
}
