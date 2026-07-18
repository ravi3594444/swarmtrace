'use client'

import { useState, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { TruncationBanner } from '@/components/truncation-banner'
import { SmartJson } from '@/components/swarm/SmartJson'
import { CallChainCrumbs } from '@/components/swarm/CallChainCrumbs'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { Waterfall } from '@/components/swarm/Waterfall'
import { TraceTable } from '@/components/swarm/TraceTable'
import type { Trace } from '@/lib/trace-types'
import { buildSpanTree, countDescendants, hasTreeError, type SpanNode } from '@/lib/span-tree'
import { tracesToCsv, downloadCsv, downloadJson } from '@/lib/csv-export'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useIntegrations } from '@/contexts/IntegrationsContext'
import {
  ChevronRight, ChevronDown, X, Clock, Activity, Coins,
  AlertTriangle, Search, Pause, Play, GitBranch, Table2, BarChart2, Wrench, Globe,
  Tag, Download, FileJson, FileText,
} from 'lucide-react'

type ViewMode = 'tree' | 'table' | 'waterfall'

// ── Export helpers ─────────────────────────────────────────────────────────────

function exportJSON(traces: Trace[]) {
  // Guard against empty data — without this, the user could download a
  // file containing just "[]" (no traces). The menu button is also
  // disabled when there's no data, but this is belt-and-suspenders.
  if (traces.length === 0) return
  downloadJson(JSON.stringify(traces, null, 2), `swarmtrace-traces-${new Date().toISOString().slice(0, 10)}.json`)
}

function exportCSV(traces: Trace[]) {
  // Guard against empty data — without this, the user could download a
  // CSV containing only the header row (no data rows).
  if (traces.length === 0) return
  // tracesToCsv() in lib/csv-export.ts sanitizes every cell against
  // formula injection (=, +, -, @, tab, CR prefixes) — see the audit
  // finding documented there.
  const csv = tracesToCsv(traces)
  downloadCsv(csv, `swarmtrace-traces-${new Date().toISOString().slice(0, 10)}.csv`)
}

function ExportMenu({ traces }: { traces: Trace[] }) {
  const [open, setOpen] = useState(false)
  const hasTraces = traces.length > 0
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={!hasTraces}
        title={hasTraces ? 'Export traces' : 'No traces to export yet'}
        className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
      >
        <Download className="w-3.5 h-3.5" />
        Export
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && hasTraces && (
        <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          <button
            onClick={() => { exportJSON(traces); setOpen(false) }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
          >
            <FileJson className="w-3.5 h-3.5 text-primary" /> Export JSON
          </button>
          <button
            onClick={() => { exportCSV(traces); setOpen(false) }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
          >
            <FileText className="w-3.5 h-3.5 text-primary" /> Export CSV
          </button>
        </div>
      )}
    </div>
  )
}

// ── Tag filter bar ─────────────────────────────────────────────────────────────

/**
 * Derives "tags" from trace fields: kind, agent_name, and any function prefix
 * (e.g. "search_web" → tag "search"). Users can click to toggle tag filters.
 */
function TagFilterBar({
  traces,
  activeTags,
  onToggle,
  onClear,
}: {
  traces: Trace[]
  activeTags: Set<string>
  onToggle: (tag: string) => void
  onClear: () => void
}) {
  // Collect all unique tags from kind + agent_name
  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of traces) {
      const tags: string[] = []
      if (t.kind && t.kind !== 'function') tags.push(`kind:${t.kind}`)
      if (t.agent_name) tags.push(`agent:${t.agent_name}`)
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }))
  }, [traces])

  if (allTags.length === 0) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/10 flex-wrap">
      <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Tags:</span>
      {allTags.map(({ tag, count }) => {
        const active = activeTags.has(tag)
        const [prefix, label] = tag.split(':')
        return (
          <button
            key={tag}
            onClick={() => onToggle(tag)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all
              ${active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground'}`}
          >
            <span className="opacity-60">{prefix}:</span>
            <span>{label}</span>
            <span className={`ml-0.5 ${active ? 'opacity-70' : 'opacity-40'}`}>({count})</span>
          </button>
        )
      })}
      {activeTags.size > 0 && (
        <button
          onClick={onClear}
          className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-2.5 h-2.5" /> Clear
        </button>
      )}
    </div>
  )
}

function TraceDetail({ trace, allTraces, onClose, onJump }: {
  trace: Trace; allTraces: Trace[]; onClose: () => void; onJump: (t: Trace) => void
}) {
  const ok = !trace.error
  return (
    <div className="h-full flex flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
        <div className="min-w-0">
          <div className={`text-sm font-semibold truncate ${ok ? 'text-foreground' : 'text-destructive'}`}>
            {trace.function}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{trace.id}</div>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 ml-2">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!ok && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              <span className="text-xs font-semibold text-destructive">Error</span>
            </div>
            <pre className="font-mono text-xs text-destructive break-all whitespace-pre-wrap">{trace.error}</pre>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Latency', value: `${(trace.latency_sec ?? 0).toFixed(3)}s`, icon: Clock },
            { label: 'Tokens', value: ((trace.input_tokens ?? 0) + (trace.output_tokens ?? 0)).toLocaleString(), icon: Activity },
            { label: 'Cost', value: `$${(trace.cost_usd ?? 0).toFixed(5)}`, icon: Coins },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-muted/30 p-2.5 text-center">
              <Icon className="w-3 h-3 text-muted-foreground mx-auto mb-1" />
              <div className="font-mono text-xs font-bold text-foreground">{value}</div>
              <div className="text-[10px] text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Status</div>
          <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase border ${ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
            {ok ? 'SUCCESS' : 'ERROR'}
          </span>
        </div>

        {/* Tags row */}
        {(trace.kind || trace.agent_name) && (
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Tags</div>
            <div className="flex flex-wrap gap-1.5">
              {trace.kind && (
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  kind:{trace.kind}
                </span>
              )}
              {trace.agent_name && (
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  agent:{trace.agent_name}
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Call Chain</div>
          <CallChainCrumbs trace={trace} allTraces={allTraces} onJump={onJump} />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Input</div>
          <SmartJson raw={trace.args} maxHeight="180px" />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Output</div>
          <SmartJson raw={trace.output} maxHeight="200px" />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Details</div>
          <div className="rounded-xl border border-border bg-muted/20 overflow-hidden">
            {([
              ['Span ID', trace.id],
              ['Trace ID', trace.trace_id ?? '(root span)'],
              ['Parent ID', trace.parent_id ?? '(root span)'],
              ['Timestamp', new Date(trace.timestamp).toLocaleString()],
              ['Input tokens', (trace.input_tokens ?? 0).toLocaleString()],
              ['Output tokens', (trace.output_tokens ?? 0).toLocaleString()],
              ['Total tokens', ((trace.input_tokens ?? 0) + (trace.output_tokens ?? 0)).toLocaleString()],
              ['Cost (USD)', `$${(trace.cost_usd ?? 0).toFixed(6)}`],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4 px-3 py-2 border-b border-border/40 last:border-0">
                <span className="text-xs text-muted-foreground shrink-0">{k}</span>
                <span className="text-xs font-mono text-foreground text-right break-all">{v}</span>
              </div>
            ))}
            {trace.attributes && Object.keys(trace.attributes).length > 0 && (
              <div className="px-3 py-2 border-b border-border/40 last:border-0">
                <div className="text-xs text-muted-foreground mb-1.5">Attributes</div>
                <SmartJson raw={JSON.stringify(trace.attributes)} maxHeight="160px" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SpanRow({ node, depth, selected, onSelect, maxLatency }: {
  node: SpanNode; depth: number; selected: Trace | null
  onSelect: (t: Trace) => void; maxLatency: number
}) {
  const [expanded, setExpanded] = useState(depth === 0)
  const isRoot = depth === 0
  const hasErr = isRoot ? hasTreeError(node) : !!node.error
  const isSelected = selected?.id === node.id
  const hasKids = node.children.length > 0
  const descCount = isRoot ? countDescendants(node) : 0
  const nodeLat = node.latency_sec ?? 0
  const pct = Math.max(3, (nodeLat / Math.max(maxLatency, 0.001)) * 100)
  const lat = nodeLat >= 1 ? `${nodeLat.toFixed(2)}s` : `${Math.round(nodeLat * 1000)}ms`

  return (
    <div className={isRoot ? 'border-b border-border' : ''}>
      <div
        onClick={() => onSelect(node)}
        className={[
          'flex items-center gap-2 pr-4 cursor-pointer transition-colors border-l-2',
          isRoot ? 'py-2.5' : 'py-1.5',
          isSelected ? 'bg-primary/[0.06] border-l-primary' : 'hover:bg-muted/40 border-l-transparent',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 18 + 12}px` }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); if (hasKids) setExpanded((v) => !v) }}
          className={`w-4 h-4 flex items-center justify-center shrink-0 rounded ${hasKids ? 'text-muted-foreground hover:text-foreground' : 'pointer-events-none'}`}
        >
          {hasKids
            ? expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
            : <span className="w-1 h-1 block rounded-full bg-muted-foreground/20" />}
        </button>

        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasErr ? 'bg-red-400' : 'bg-emerald-500'}`} />

        <span className={['text-xs truncate min-w-0 flex-1', isRoot ? 'font-semibold' : 'font-medium', hasErr ? 'text-destructive' : 'text-foreground'].join(' ')}>
          {node.function}
        </span>

        {/* Kind badge */}
        {node.kind && node.kind !== 'function' && (
          <span className="hidden lg:inline-block text-[10px] font-bold uppercase rounded-full px-1.5 py-0.5 border border-border bg-muted/40 text-muted-foreground shrink-0">
            {node.kind}
          </span>
        )}

        {isRoot && descCount > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/50 shrink-0 hidden lg:block">+{descCount}</span>
        )}

        <span className="font-mono text-[10px] text-muted-foreground/35 shrink-0 w-16 text-right hidden lg:block truncate">
          {node.id.slice(0, 8)}
        </span>

        <div className="relative h-1 w-14 shrink-0 rounded-full bg-muted overflow-hidden hidden xl:block">
          <div className={`absolute left-0 top-0 h-full rounded-full ${hasErr ? 'bg-red-300' : 'bg-primary/40'}`} style={{ width: `${pct}%` }} />
        </div>

        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right">{lat}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0 w-14 text-right hidden xl:block">
          {((node.input_tokens ?? 0) + (node.output_tokens ?? 0)).toLocaleString()}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground font-semibold shrink-0 w-16 text-right">
          ${(node.cost_usd ?? 0).toFixed(4)}
        </span>

        <span className={`text-[10px] font-bold uppercase rounded-full px-1.5 py-0.5 border shrink-0 ${hasErr ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
          {hasErr ? 'ERR' : 'OK'}
        </span>
      </div>

      {expanded && hasKids && node.children.map((c) => (
        <SpanRow key={c.id} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} maxLatency={maxLatency} />
      ))}
    </div>
  )
}

const VIEW_BUTTONS: { mode: ViewMode; icon: typeof GitBranch; label: string }[] = [
  { mode: 'tree',      icon: GitBranch, label: 'Tree' },
  { mode: 'table',     icon: Table2,    label: 'Table' },
  { mode: 'waterfall', icon: BarChart2, label: 'Waterfall' },
]

// ── Integration Panels ────────────────────────────────────────────────────────

function ToolAttentionPanel({ traces }: { traces: Trace[] }) {
  const tools = useMemo(() => {
    const map = new Map<string, { calls: number; totalLatency: number; errors: number }>()
    for (const t of traces) {
      if (t.kind !== 'tool') continue
      const e = map.get(t.function) || { calls: 0, totalLatency: 0, errors: 0 }
      e.calls++; e.totalLatency += t.latency_sec ?? 0; if (t.error) e.errors++
      map.set(t.function, e)
    }
    return Array.from(map.entries())
      .map(([name, s]) => ({ name, calls: s.calls, avgLatency: s.totalLatency / s.calls, errors: s.errors }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 6)
  }, [traces])

  const maxCalls = tools[0]?.calls || 1

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden mb-5">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <Wrench className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Tool Attention</h3>
        <span className="ml-1.5 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />ACTIVE
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">kind=tool spans only</span>
      </div>
      <div className="p-4">
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            No tool spans recorded yet. Decorate tool functions with <code className="font-mono text-xs bg-muted px-1 rounded">@observe(kind=&quot;tool&quot;)</code>.
          </p>
        ) : (
          <div className="space-y-2.5">
            {tools.map(t => (
              <div key={t.name} className="flex items-center gap-3">
                <span className="text-xs font-mono text-foreground truncate w-40 shrink-0">{t.name}</span>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(t.calls / maxCalls) * 100}%` }} />
                </div>
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">{t.calls} calls</span>
                <span className="text-xs text-muted-foreground w-16 text-right shrink-0">{t.avgLatency.toFixed(2)}s avg</span>
                {t.errors > 0 && (
                  <span className="text-xs text-red-500 shrink-0">{t.errors} err</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ScrapingBanner({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary/5 border border-primary/20 mb-4 text-sm">
      <Globe className="w-4 h-4 text-primary shrink-0" />
      <span className="text-foreground">
        <span className="font-semibold text-primary">{count}</span> scraping trace{count !== 1 ? 's' : ''} found
      </span>
      <span className="text-xs text-muted-foreground ml-1">— Scrapling integration active</span>
    </div>
  )
}

export default function TracesPage() {
  const { traces, truncated, loading, isLive, toggleLive } = useSwarmTraces(8000)
  const [selected, setSelected] = useState<Trace | null>(null)
  const { isEnabled } = useIntegrations()
  const scrapingCount = useMemo(
    // The scraper records traces with kind="tool" and function="scrape"
    // (see swarmtrace/scraper.py), so we identify scraping spans by the
    // function name. The kind === 'scraping' check was a placeholder for
    // a kind value that never existed in the type union.
    () => traces.filter(t => t.function.toLowerCase().includes('scrap')).length,
    [traces]
  )
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'OK' | 'ERROR'>('ALL')
  const [view, setView] = useState<ViewMode>('tree')

  // Custom date range (inclusive, local time). Empty string = unbounded.
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const fromMs = useMemo(() => (fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : NaN), [fromDate])
  const toMs = useMemo(() => (toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : NaN), [toDate])

  // ── Tag-based filtering ──────────────────────────────────────────────────────
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set())

  const toggleTag = (tag: string) => {
    setActiveTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  const clearTags = () => setActiveTags(new Set())

  const filtered = useMemo(() => traces.filter((t) => {
    if (statusFilter === 'OK' && t.error) return false
    if (statusFilter === 'ERROR' && !t.error) return false
    if (search) {
      const q = search.toLowerCase()
      if (!t.function.toLowerCase().includes(q) && !t.id.toLowerCase().includes(q)) return false
    }
    if (Number.isFinite(fromMs) || Number.isFinite(toMs)) {
      const ms = new Date(t.timestamp).getTime()
      if (Number.isFinite(fromMs) && ms < fromMs) return false
      if (Number.isFinite(toMs) && ms > toMs) return false
    }
    // Tag filtering: trace must match ALL active tags
    if (activeTags.size > 0) {
      for (const tag of activeTags) {
        const [prefix, value] = tag.split(':')
        if (prefix === 'kind' && t.kind !== value) return false
        if (prefix === 'agent' && t.agent_name !== value) return false
      }
    }
    return true
  }), [traces, search, statusFilter, activeTags, fromMs, toMs])

  const roots = useMemo(() => buildSpanTree(filtered), [filtered])
  const maxLatency = useMemo(() => filtered.reduce((m, t) => Math.max(m, t.latency_sec ?? 0), 0.001), [filtered])

  if (loading) return (
    <DashboardSkeleton title="Traces" description="Click any row to inspect" />
  )

  const errorCount = filtered.filter((t) => t.error).length

  return (
    <DashboardLayout>
      <PageHeader
        title="Traces"
        description="Click any row to inspect"
        liveStatus={isLive ? 'live' : 'paused'}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* View toggle */}
            <div className="flex items-center rounded-lg border border-border bg-card shadow-sm overflow-hidden">
              {VIEW_BUTTONS.map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setView(mode)}
                  title={label}
                  className={`flex items-center gap-1.5 h-8 px-3 text-xs font-medium transition-colors
                    ${view === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'}`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text" placeholder="Search spans…" value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 rounded-lg border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring shadow-sm w-44"
              />
            </div>
            <div className="flex items-center gap-1 h-8 rounded-lg border border-border bg-card px-2 text-xs text-muted-foreground shadow-sm" title="Filter by date range">
              <input
                type="date" value={fromDate} max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="From date"
                className="bg-transparent text-xs text-foreground focus:outline-none w-[7.5rem]"
              />
              <span className="text-muted-foreground/60">–</span>
              <input
                type="date" value={toDate} min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="To date"
                className="bg-transparent text-xs text-foreground focus:outline-none w-[7.5rem]"
              />
              {(fromDate || toDate) && (
                <button
                  onClick={() => { setFromDate(''); setToDate('') }}
                  aria-label="Clear date range"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {(['ALL', 'OK', 'ERROR'] as const).map((f) => (
              <button key={f} onClick={() => setStatusFilter(f)}
                className={`h-8 rounded-lg px-3 text-xs font-medium shadow-sm transition-all ${statusFilter === f ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:text-foreground'}`}>
                {f}
              </button>
            ))}
            <button onClick={toggleLive}
              className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm">
              {isLive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {isLive ? 'Pause' : 'Resume'}
            </button>
            <ExportMenu traces={filtered} />
          </div>
        }
      />

      {truncated && <TruncationBanner />}

      {/* Tag filter bar — always visible when tags exist */}
      <TagFilterBar
        traces={traces}
        activeTags={activeTags}
        onToggle={toggleTag}
        onClear={clearTags}
      />

      {/* Integration Panels — table/waterfall only; tree view uses full viewport height */}
      {view !== 'tree' && (isEnabled('tool-attention') || (isEnabled('scrapling') && scrapingCount > 0)) && (
        <div className="px-6 pt-6">
          {isEnabled('scrapling') && scrapingCount > 0 && <ScrapingBanner count={scrapingCount} />}
          {isEnabled('tool-attention') && <ToolAttentionPanel traces={traces} />}
        </div>
      )}

      {/* Waterfall — full width, no side panel */}
      {view === 'waterfall' && (
        <div className="p-6">
          <Waterfall traces={filtered} onSelect={setSelected} />
          {selected && (
            <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden shadow-sm max-h-[50vh] overflow-y-auto">
              <TraceDetail trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
            </div>
          )}
        </div>
      )}

      {/* Table — full width, no side panel */}
      {view === 'table' && (
        <div className="p-6">
          <TraceTable traces={filtered} onSelect={setSelected} selected={selected} />
          {selected && (
            <div className="mt-4 rounded-xl border border-border bg-card overflow-hidden shadow-sm max-h-[50vh] overflow-y-auto">
              <TraceDetail trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
            </div>
          )}
        </div>
      )}

      {/* Tree — resizable split panel. Uses dynamic viewport height (dvh)
          to fill the screen below the PageHeader. The calc accounts for:
          - 48px mobile top bar (pt-12) on small screens, 0 on lg+
          - ~64px PageHeader height (varies slightly with toolbar wrapping,
            but 64px is the common case; overflow-y on the list handles the
            rest). Using 100dvh (dynamic viewport height) instead of 100vh
          so mobile browser chrome (address bar show/hide) doesn't cause
          the tree to overflow/underflow. */}
      {view === 'tree' && (
        <div className="p-6 pt-3">
          <div className="h-[calc(100dvh-48px-64px-1.5rem)] lg:h-[calc(100dvh-64px-1.5rem)] border border-border bg-card rounded-xl overflow-hidden shadow-sm">
            <PanelGroup direction="horizontal" className="h-full">
              <Panel defaultSize={selected ? 58 : 100} minSize={38}>
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground tabular-nums">{filtered.length}</span> spans
                      {errorCount > 0 && <span className="ml-2 text-red-600 font-medium">· {errorCount} error{errorCount > 1 ? 's' : ''}</span>}
                      {filtered.length !== traces.length && <span className="ml-1 text-muted-foreground/60">(of {traces.length})</span>}
                      {activeTags.size > 0 && (
                        <span className="ml-2 text-primary font-medium">· {activeTags.size} tag filter{activeTags.size > 1 ? 's' : ''} active</span>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
                    <div className="w-4 shrink-0" />
                    <div className="w-1.5 shrink-0" />
                    <div className="flex-1">Span / Function</div>
                    <div className="w-12 text-right hidden lg:block">Kind</div>
                    <div className="w-16 text-right hidden lg:block">ID</div>
                    <div className="w-14 hidden xl:block" />
                    <div className="w-14 text-right">Latency</div>
                    <div className="w-14 text-right hidden xl:block">Tokens</div>
                    <div className="w-16 text-right">Cost</div>
                    <div className="w-10 shrink-0" />
                  </div>

                  <div className="flex-1 overflow-y-auto">
                    {roots.length === 0 ? (
                      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
                        {traces.length === 0 ? 'No spans yet.' : 'No spans match your filters.'}
                      </div>
                    ) : (
                      roots.map((root) => (
                        <SpanRow key={root.id} node={root} depth={0} selected={selected} onSelect={setSelected} maxLatency={maxLatency} />
                      ))
                    )}
                  </div>
                </div>
              </Panel>

              {selected && (
                <>
                  <PanelResizeHandle className="w-1 bg-border hover:bg-primary/40 transition-colors cursor-col-resize" />
                  <Panel defaultSize={42} minSize={28} maxSize={65}>
                    <TraceDetail trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
