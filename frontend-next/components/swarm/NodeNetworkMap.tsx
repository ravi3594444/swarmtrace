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
    color: '#ffffff',
    glow: 'rgba(255, 255, 255, 0.55)',
    target: { x: WIDTH * 0.48, y: HEIGHT * 0.44 },
  },
  sub_agent: {
    label: 'Sub-agent',
    color: '#c6c6c7',
    glow: 'rgba(198, 198, 199, 0.42)',
    target: { x: WIDTH * 0.58, y: HEIGHT * 0.54 },
  },
  peer: {
    label: 'Peer',
    color: '#8e9192',
    glow: 'rgba(142, 145, 146, 0.35)',
    target: { x: WIDTH * 0.38, y: HEIGHT * 0.56 },
  },
  solo: {
    label: 'Solo',
    color: '#444748',
    glow: 'rgba(142, 145, 146, 0.24)',
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
      color: node.errors > 0 ? '#ffb4ab' : style.color,
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
  if (mode === 'orchestrator') return 'border-white bg-white text-black'
  if (mode === 'sub_agent') return 'border-[#c6c6c7]/50 bg-[#c6c6c7]/10 text-[#e5e2e1]'
  if (mode === 'peer') return 'border-[#8e9192]/50 bg-[#8e9192]/10 text-[#c4c7c8]'
  return 'border-[#444748] bg-[#201f1f] text-[#8e9192]'
}

function EmptyNetwork() {
  return (
    <div className="flex min-h-[620px] items-center justify-center rounded-[2rem] border border-[#333333] bg-[#0e0e0e] text-center">
      <div className="max-w-md px-8">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-white/10">
          <Radio className="h-7 w-7 text-white" />
        </div>
        <h2 className="text-2xl font-semibold text-white">No agent network yet</h2>
        <p className="mt-2 text-sm leading-6 text-[#8e9192]">
          Run agents with <code className="rounded bg-white/10 px-1 py-0.5 text-white">@observe</code>,
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
  const [graphMode, setGraphMode] = useState<'swarm' | 'rag'>('swarm')
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
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="relative min-h-[720px] overflow-hidden rounded-[2rem] border border-[#333333] bg-[#0a0a0a]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.10),transparent_34%),radial-gradient(circle_at_78%_28%,rgba(198,198,199,0.08),transparent_24%),radial-gradient(circle_at_22%_72%,rgba(142,145,146,0.09),transparent_25%),linear-gradient(180deg,#0e0e0e,#0a0a0a_52%,#000)]" />
        <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.10)_1px,transparent_1px)] [background-size:34px_34px]" />
        <div className="absolute inset-0 opacity-25 [background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.16)_0,transparent_34%)]" />

        <div className="absolute left-5 right-5 top-5 z-20 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight text-white">Node Network Map</h2>
              <span className="rounded-full border border-white/30 bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[#e5e2e1]">
                {isLive ? 'Live' : 'Paused'}
              </span>
              {truncated && (
                <span className="rounded-full border border-[#777777] bg-[#201f1f] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[#c4c7c8]">
                  partial
                </span>
              )}
            </div>
            <p className="mt-1 flex items-center gap-2 text-sm text-[#8e9192]">
              <Move className="h-4 w-4" /> Drag to pan · scroll to zoom · click any agent node
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#333333] bg-[#121212]/80 p-1.5 backdrop-blur-xl">
            <div className="flex rounded-full border border-[#333333] bg-[#0e0e0e] p-1">
              {(['swarm', 'rag'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setGraphMode(mode)}
                  className={`rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] transition ${
                    graphMode === mode ? 'bg-white text-black' : 'text-[#8e9192] hover:text-white'
                  }`}
                >
                  {mode === 'swarm' ? 'Swarm' : 'RAG / Obsidian'}
                </button>
              ))}
            </div>
            <button onClick={() => setZoom((z) => clamp(z + 0.12, 0.55, 2.2))} className="rounded-xl border border-[#333333] bg-[#201f1f] p-2 text-[#e5e2e1] hover:border-white/60 hover:bg-[#2a2a2a]" title="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </button>
            <button onClick={() => setZoom((z) => clamp(z - 0.12, 0.55, 2.2))} className="rounded-xl border border-[#333333] bg-[#201f1f] p-2 text-[#e5e2e1] hover:border-white/60 hover:bg-[#2a2a2a]" title="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </button>
            <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} className="rounded-xl border border-[#333333] bg-[#201f1f] px-3 py-2 text-xs font-semibold text-[#e5e2e1] hover:border-white/60 hover:bg-[#2a2a2a]">
              Reset
            </button>
            <button onClick={onRefresh} className="rounded-xl border border-[#333333] bg-[#201f1f] p-2 text-[#e5e2e1] hover:border-white/60 hover:bg-[#2a2a2a]" title="Refresh graph">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={onToggleLive} className="rounded-xl border border-[#333333] bg-[#201f1f] p-2 text-[#e5e2e1] hover:border-white/60 hover:bg-[#2a2a2a]" title={isLive ? 'Pause live updates' : 'Resume live updates'}>
              {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="absolute right-6 top-32 z-20 space-y-3">
          <button
            onClick={() => setShowHeatmap((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showHeatmap ? 'border-white/60 bg-white text-black' : 'border-[#333333] bg-[#121212]/80 text-[#c4c7c8]'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#333333] bg-[#201f1f]">
              <Flame className="h-4 w-4" />
            </span>
            Heatmap
          </button>
          <button
            onClick={() => setShowLines((value) => !value)}
            className={`flex w-36 items-center gap-3 rounded-2xl border px-3 py-3 text-left text-xs font-semibold backdrop-blur-xl transition ${
              showLines ? 'border-white/60 bg-white text-black' : 'border-[#333333] bg-[#121212]/80 text-[#c4c7c8]'
            }`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#333333] bg-[#201f1f]">
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
            <radialGradient id="heatGradient">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.32" />
              <stop offset="48%" stopColor="#c6c6c7" stopOpacity="0.10" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
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

            {graphMode === 'rag' && nodes.filter((node) => node.ragSpans > 0).flatMap((node) => {
              const count = Math.min(node.ragSpans, 7)
              return Array.from({ length: count }).map((_, idx) => {
                const angle = (idx / count) * Math.PI * 2 + (hashNumber(node.id) % 90) / 57
                const radius = node.r + 44 + (idx % 2) * 12
                const x = node.x + Math.cos(angle) * radius
                const y = node.y + Math.sin(angle) * radius
                return (
                  <g key={`rag-${node.id}-${idx}`} opacity={highlighted && highlighted.id !== node.id ? 0.34 : 0.92}>
                    <line x1={node.x} y1={node.y} x2={x} y2={y} stroke="#c6c6c7" strokeOpacity="0.28" strokeWidth="0.9" strokeDasharray="3 7" />
                    <rect x={x - 4.5} y={y - 4.5} width="9" height="9" rx="2" fill="#e5e2e1" opacity="0.9" />
                  </g>
                )
              })
            })}

            {showLines && edges.map((edge) => {
              const isActive = connectedIds.has(edge.source) && connectedIds.has(edge.target)
              const stroke = edge.relation === 'orchestrates' ? '#ffffff' : '#777777'
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

            {nodes.map((node) => {
              const active = selected?.id === node.id
              const hoveredNode = hoveredId === node.id
              const dimmed = (highlighted && !connectedIds.has(node.id)) || (graphMode === 'rag' && node.ragSpans === 0)
              const style = MODE_STYLE[node.collaborationMode]
              return (
                <g
                  key={node.id}
                  opacity={dimmed ? 0.32 : 1}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={(event) => { event.stopPropagation(); setSelectedId(node.id) }}
                  className="cursor-pointer"
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r + 13}
                    fill={style.glow}
                    opacity={active || hoveredNode ? 0.42 : 0.16}
                    filter="url(#nodeGlow)"
                  />
                  {node.status === 'RUNNING' && (
                    <circle cx={node.x} cy={node.y} r={node.r + 9} fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="1.4" />
                  )}
                  {node.ragSpans > 0 && (
                    <circle cx={node.x} cy={node.y} r={node.r + 5} fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="2" />
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={node.color}
                    stroke={active ? '#ffffff' : node.errors > 0 ? '#ffdad6' : '#c6c6c7'}
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
                        fill="rgba(14, 14, 14, 0.88)"
                        stroke="rgba(255, 255, 255, 0.22)"
                      />
                      <text x={node.x} y={node.y + node.r + 28} textAnchor="middle" className="fill-white text-[12px] font-semibold">
                        {node.label.slice(0, 18)}
                      </text>
                      <text x={node.x} y={node.y + node.r + 43} textAnchor="middle" className="fill-[#8e9192] text-[10px]">
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
            <div key={item.label} className="rounded-2xl border border-[#333333] bg-[#121212]/80 px-4 py-3 backdrop-blur-xl">
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#777777]">{item.label}</div>
              <div className="mt-1 font-mono text-xl font-bold text-white">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <aside className="rounded-[2rem] border border-[#333333] bg-[#0e0e0e] p-5 text-[#e5e2e1]">
        {selected && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-[0.26em] text-[#c6c6c7]">Selected Agent</div>
                <h3 className="mt-2 truncate text-2xl font-semibold text-white">{selected.label}</h3>
                <p className="mt-1 break-all font-mono text-[11px] text-[#777777]">{selected.id}</p>
              </div>
              <span className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${modePillClass(selected.collaborationMode)}`}>
                {formatMode(selected.collaborationMode)}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${selected.status === 'ERROR' ? 'border-[#ffb4ab]/40 bg-[#ffb4ab]/10 text-[#ffdad6]' : selected.status === 'RUNNING' ? 'border-white/40 bg-white/10 text-white' : 'border-[#444748] bg-[#201f1f] text-[#c4c7c8]'}`}>
                {selected.status}
              </span>
              {selected.ragSpans > 0 && (
                <span className="rounded-full border border-white/40 bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                  RAG · {selected.ragSpans}
                </span>
              )}
              {selected.errors > 0 && (
                <span className="rounded-full border border-red-400/40 bg-red-400/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-red-200">
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
                <div key={item.label} className="rounded-2xl border border-[#333333] bg-[#121212] p-4">
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">{item.label}</div>
                  <div className="mt-1 font-mono text-lg font-bold text-white">{item.value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-[#333333] bg-[#121212] p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">Last activity</div>
              <div className="mt-1 text-sm text-[#e5e2e1]">
                {selected.lastActive ? formatRelativeTime(selected.lastActive) : 'unknown'}
              </div>
              <div className="mt-2 h-2 rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#777777] via-[#c6c6c7] to-white"
                  style={{ width: `${clamp((selected.spans / Math.max(...nodes.map((node) => node.spans), 1)) * 100, 8, 100)}%` }}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-[#333333] bg-[#121212] p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">Connections</div>
                <span className="text-xs text-[#777777]">{edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length}</span>
              </div>
              <div className="space-y-2">
                {edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).slice(0, 8).map((edge) => {
                  const other = edge.source === selected.id ? edge.targetNode : edge.sourceNode
                  return (
                    <button
                      key={edge.id}
                      onClick={() => setSelectedId(other.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-left transition hover:border-white/50 hover:bg-white/5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-white">{other.label}</div>
                        <div className="text-[10px] text-[#777777]">{edge.relation} · {edge.calls} call{edge.calls === 1 ? '' : 's'}</div>
                      </div>
                      <span className={`h-2.5 w-2.5 rounded-full ${other.errors > 0 ? 'bg-[#ffb4ab]' : 'bg-white'}`} />
                    </button>
                  )
                })}
                {edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).length === 0 && (
                  <div className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-center text-xs text-[#777777]">
                    No collaboration edges for this agent in the current range.
                  </div>
                )}
              </div>
            </div>

            <Link
              href="/traces"
              className="block rounded-2xl border border-white bg-white px-4 py-3 text-center text-sm font-semibold text-black transition hover:bg-[#e2e2e2]"
            >
              View trace details
            </Link>
          </div>
        )}
      </aside>
    </div>
  )
}
