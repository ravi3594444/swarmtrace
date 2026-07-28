'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Flame,
  Move,
  Pause,
  Play,
  Radio,
  RefreshCw,
  SlidersHorizontal,
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

type PositionedNode = AgentGraphNode & {
  x: number
  y: number
  r: number
  color: string
  heat: number
}

type PositionedEdge = AgentGraphEdge & {
  sourceNode: PositionedNode
  targetNode: PositionedNode
}

const MODE_STYLE: Record<CollaborationMode, { label: string; color: string; glow: string; target: { x: number; y: number } }> = {
  orchestrator: {
    label: 'Orchestrator',
    color: '#ffffff', // primary — brightest, most emphasis
    glow: 'rgba(255, 255, 255, 0.55)',
    target: { x: WIDTH * 0.48, y: HEIGHT * 0.44 },
  },
  sub_agent: {
    label: 'Sub-agent',
    color: '#e5e2e1', // on-surface
    glow: 'rgba(229, 226, 225, 0.45)',
    target: { x: WIDTH * 0.58, y: HEIGHT * 0.54 },
  },
  peer: {
    label: 'Peer',
    color: '#c4c7c8', // on-surface-variant
    glow: 'rgba(196, 199, 200, 0.4)',
    target: { x: WIDTH * 0.38, y: HEIGHT * 0.56 },
  },
  solo: {
    label: 'Solo',
    color: '#8e9192', // outline — dimmest, least emphasis
    glow: 'rgba(142, 145, 146, 0.32)',
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

function layoutGraph(graph: AgentNetworkGraph): { nodes: PositionedNode[]; edges: PositionedEdge[] } {
  const nodes: PositionedNode[] = graph.nodes.map((node, index) => {
    const seed = hashNumber(node.id)
    const style = MODE_STYLE[node.collaborationMode]
    const angle = ((seed % 360) / 180) * Math.PI
    const ring = 80 + (index % 9) * 26 + (seed % 80)
    return {
      ...node,
      x: style.target.x + Math.cos(angle) * ring + jitter(seed, 70),
      y: style.target.y + Math.sin(angle) * ring + jitter(seed >> 8, 70),
      r: nodeRadius(node),
      color: node.errors > 0 ? ERROR_COLOR : style.color,
      heat: nodeHeat(node),
    }
  })

  const indexById = new Map(nodes.map((node, index) => [node.id, index]))
  const velocities = nodes.map(() => ({ x: 0, y: 0 }))

  for (let iteration = 0; iteration < 150; iteration += 1) {
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

    for (const edge of graph.edges) {
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
    <div className="flex min-h-[620px] items-center justify-center rounded-[2rem] border border-border bg-card text-center shadow-2xl">
      <div className="max-w-md px-8">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-secondary">
          <Radio className="h-7 w-7 text-foreground" />
        </div>
        <h2 className="text-2xl font-semibold text-foreground">No agent network yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Run agents with <code className="rounded bg-white/10 px-1 py-0.5 text-foreground">@observe</code>,
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
  const { nodes, edges } = useMemo(() => layoutGraph(graph), [graph])
  const [selectedId, setSelectedId] = useState<string | null>(nodes[0]?.id ?? null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showHeatmap, setShowHeatmap] = useState(true)
  const [showLines, setShowLines] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

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

  if (nodes.length === 0) return <EmptyNetwork />

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="relative min-h-[720px] overflow-hidden rounded-[2rem] border border-border bg-background shadow-[0_30px_100px_rgba(0,0,0,0.55)]">
        {/* Achromatic vignette + grid — no blue/violet/cyan, brightness only */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.06),transparent_34%),radial-gradient(circle_at_78%_28%,rgba(255,255,255,0.04),transparent_24%),radial-gradient(circle_at_22%_72%,rgba(255,255,255,0.05),transparent_25%),linear-gradient(180deg,#0e0e0e,#0a0a0a_52%,#000)]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(142,145,146,0.14)_1px,transparent_1px),linear-gradient(90deg,rgba(142,145,146,0.14)_1px,transparent_1px)] [background-size:34px_34px]" />
        <div className="absolute inset-0 opacity-25 [background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.10)_0,transparent_34%)]" />

        <div className="absolute left-5 right-5 top-5 z-20 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">Node Network Map</h2>
              {/* Live/partial keep the app's existing status-color convention (emerald = live, amber = warning) */}
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-200">
                {isLive ? 'Live' : 'Paused'}
              </span>
              {truncated && (
                <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-amber-200">
                  partial
                </span>
              )}
            </div>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Move className="h-4 w-4" /> Drag to pan · scroll to zoom · click any agent node
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-border bg-black/30 p-1.5 backdrop-blur-xl">
            <button onClick={() => setZoom((z) => clamp(z + 0.12, 0.55, 2.2))} className="rounded-xl border border-border bg-white/5 p-2 text-foreground hover:bg-white/10" title="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </button>
            <button onClick={() => setZoom((z) => clamp(z - 0.12, 0.55, 2.2))} className="rounded-xl border border-border bg-white/5 p-2 text-foreground hover:bg-white/10" title="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} className="rounded-xl border border-border bg-white/5 px-3 py-2 text-xs font-semibold text-foreground hover:bg-white/10">
              Reset
            </button>
            <button onClick={onRefresh} className="rounded-xl border border-border bg-white/5 p-2 text-foreground hover:bg-white/10" title="Refresh graph">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={onToggleLive} className="rounded-xl border border-border bg-white/5 p-2 text-foreground hover:bg-white/10" title={isLive ? 'Pause live updates' : 'Resume live updates'}>
              {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="absolute right-6 top-32 z-20 space-y-3">
          <button
            onClick={() => setShowHeatmap((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showHeatmap ? 'border-primary/50 bg-primary/10 text-foreground shadow-[0_0_30px_rgba(255,255,255,0.15)]' : 'border-border bg-black/35 text-muted-foreground'
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
              showLines ? 'border-primary/50 bg-primary/10 text-foreground shadow-[0_0_30px_rgba(255,255,255,0.15)]' : 'border-border bg-black/35 text-muted-foreground'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            Connections
          </button>
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
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
              <stop offset="48%" stopColor="#e5e2e1" stopOpacity="0.11" />
              <stop offset="100%" stopColor="#e5e2e1" stopOpacity="0" />
            </radialGradient>
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
              const stroke = edge.relation === 'orchestrates' ? '#e5e2e1' : '#8e9192'
              return (
                <line
                  key={edge.id}
                  x1={edge.sourceNode.x}
                  y1={edge.sourceNode.y}
                  x2={edge.targetNode.x}
                  y2={edge.targetNode.y}
                  stroke={stroke}
                  strokeWidth={isActive ? 1.8 + Math.min(edge.calls, 6) * 0.15 : 0.8}
                  strokeOpacity={isActive ? 0.72 : 0.18}
                  strokeDasharray={edge.relation === 'peer' ? '4 7' : undefined}
                />
              )
            })}

            {nodes.map((node, nodeIndex) => {
              const active = selected?.id === node.id
              const hoveredNode = hoveredId === node.id
              const dimmed = highlighted && !connectedIds.has(node.id)
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
                    } else if (event.key === 'ArrowRight') {
                      event.preventDefault()
                      const next = nodes[(nodeIndex + 1) % nodes.length]
                      setSelectedId(next.id)
                      ;(event.currentTarget.parentElement?.children[nodeIndex + 1] as SVGElement | undefined)?.focus?.()
                    } else if (event.key === 'ArrowLeft') {
                      event.preventDefault()
                      const prev = nodes[(nodeIndex - 1 + nodes.length) % nodes.length]
                      setSelectedId(prev.id)
                      ;(event.currentTarget.parentElement?.children[nodeIndex - 1] as SVGElement | undefined)?.focus?.()
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
                  {/* RAG ring uses the primary (white) accent — deliberately distinct from the
                      status-green ring above, since an agent can be RUNNING and RAG-using at once */}
                  {node.ragSpans > 0 && (
                    <circle cx={node.x} cy={node.y} r={node.r + 5} fill="none" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="2" />
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={node.color}
                    stroke={active ? '#ffffff' : node.errors > 0 ? '#ffdad6' : '#8e9192'}
                    strokeOpacity={active ? 0.95 : 0.55}
                    strokeWidth={active ? 2.5 : 1.2}
                    filter="url(#nodeGlow)"
                  />
                  <circle cx={node.x - node.r * 0.28} cy={node.y - node.r * 0.28} r={Math.max(2, node.r * 0.22)} fill="#fff" opacity="0.55" />
                  {(active || hoveredNode || node.collaborationMode === 'orchestrator') && (
                    <g>
                      <rect
                        x={node.x - 64}
                        y={node.y + node.r + 10}
                        width="128"
                        height="42"
                        rx="14"
                        fill="rgba(14, 14, 14, 0.85)"
                        stroke="rgba(142, 145, 146, 0.3)"
                      />
                      <text x={node.x} y={node.y + node.r + 28} textAnchor="middle" className="fill-white text-[12px] font-semibold">
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
            <div key={item.label} className="rounded-2xl border border-border bg-black/35 px-4 py-3 backdrop-blur-xl">
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
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${selected.status === 'ERROR' ? 'border-destructive/50 bg-destructive/15 text-destructive-foreground' : selected.status === 'RUNNING' ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' : 'border-outline-variant/50 bg-outline-variant/10 text-muted-foreground'}`}>
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
                <div key={item.label} className="rounded-2xl border border-border bg-white/[0.03] p-4">
                  <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{item.label}</div>
                  <div className="mt-1 font-mono text-lg font-bold text-foreground">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-border bg-white/[0.03] p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Last activity</div>
              <div className="mt-1 text-sm text-on-surface-variant">
                {selected.lastActive ? formatRelativeTime(selected.lastActive) : 'unknown'}
              </div>
              <div className="mt-2 h-2 rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-outline via-on-surface-variant to-primary"
                  style={{ width: `${clamp((selected.spans / Math.max(...nodes.map((node) => node.spans), 1)) * 100, 8, 100)}%` }}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-white/[0.03] p-4">
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
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-black/20 px-3 py-2 text-left transition hover:border-primary/30 hover:bg-primary/5"
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
