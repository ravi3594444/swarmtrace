'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { Search, X, AlertCircle, ChevronRight, ChevronDown } from 'lucide-react'
import { fetchTraces, formatTime } from '@/lib/api'
import { SkeletonTableRow } from '@/components/skeleton'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  || ''
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// ─── Types ────────────────────────────────────────────────────────────────────

type Span = {
  id: string
  parent_id: string | null
  function: string
  function_name: string
  kind: string | null
  status: 'SUCCESS' | 'ERROR'
  duration: number       // ms
  tokens_in: number
  tokens_out: number
  cost: number
  timestamp: string
  args: string
  output: string
  error: string | null
}

type SpanNode = Span & { children: SpanNode[] }

// ─── Tree builder ─────────────────────────────────────────────────────────────

function buildTree(spans: Span[]): SpanNode[] {
  const map = new Map<string, SpanNode>()
  spans.forEach(s => map.set(s.id, { ...s, children: [] }))

  const roots: SpanNode[] = []
  map.forEach(n => {
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children.push(n)
    } else {
      roots.push(n)
    }
  })
  // children: chronological; roots: newest first
  map.forEach(n => n.children.sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
  roots.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return roots
}

function countDesc(n: SpanNode): number {
  return n.children.reduce((s, c) => s + 1 + countDesc(c), 0)
}

function subtreeHasError(n: SpanNode): boolean {
  return !!n.error || n.children.some(subtreeHasError)
}

// ─── Kind badge ───────────────────────────────────────────────────────────────

const KIND_STYLES: Record<string, string> = {
  agent:    'bg-violet-500/10 text-violet-500 border-violet-500/20',
  tool:     'bg-blue-500/10   text-blue-500   border-blue-500/20',
  llm:      'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  function: 'bg-zinc-500/10  text-zinc-500   border-zinc-400/20',
}

function KindBadge({ kind }: { kind: string | null }) {
  const k = (kind ?? 'span').toLowerCase()
  const style = KIND_STYLES[k] ?? KIND_STYLES.function
  return (
    <span className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${style}`}>
      {k}
    </span>
  )
}

// ─── Span row (recursive) ─────────────────────────────────────────────────────

function SpanRow({
  node, depth, selected, onSelect, maxDuration, isNew,
}: {
  node: SpanNode
  depth: number
  selected: Span | null
  onSelect: (s: Span) => void
  maxDuration: number
  isNew: boolean
}) {
  const [expanded, setExpanded] = useState(depth === 0)

  const isRoot     = depth === 0
  const hasErr     = isRoot ? subtreeHasError(node) : !!node.error
  const isSelected = selected?.id === node.id
  const hasKids    = node.children.length > 0
  const descCount  = isRoot ? countDesc(node) : 0
  const barPct     = Math.max(3, (node.duration / Math.max(maxDuration, 1)) * 100)
  const latLabel   = node.duration >= 1000
    ? `${(node.duration / 1000).toFixed(2)}s`
    : `${node.duration}ms`

  return (
    <div className={isRoot ? 'border-b border-border' : ''}>
      <div
        onClick={() => onSelect(node)}
        className={[
          'group flex items-center gap-2 pr-4 cursor-pointer transition-colors border-l-2',
          isRoot ? 'py-3' : 'py-2',
          isSelected  ? 'bg-primary/5 border-l-primary'        : '',
          !isSelected && isNew ? 'bg-primary/5 border-l-primary' : '',
          !isSelected && !isNew ? 'border-l-transparent hover:bg-muted/30' : '',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 20 + 12}px` }}
      >
        {/* Expand toggle */}
        <button
          onClick={e => { e.stopPropagation(); if (hasKids) setExpanded(v => !v) }}
          className={`w-4 h-4 flex items-center justify-center shrink-0 rounded ${hasKids ? 'text-muted-foreground hover:text-foreground' : 'pointer-events-none'}`}
        >
          {hasKids
            ? expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
            : <span className="w-1 h-1 block rounded-full bg-muted-foreground/20" />}
        </button>

        {/* Status dot */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasErr ? 'bg-red-500' : 'bg-emerald-500'}`} />

        {/* Kind badge */}
        <KindBadge kind={node.kind} />

        {/* Function name */}
        <span className={`text-sm truncate min-w-0 flex-1 ${isRoot ? 'font-semibold' : 'font-medium'} ${hasErr ? 'text-red-500' : 'text-foreground'}`}>
          {node.function_name || node.function}
        </span>

        {/* Child count (root only) */}
        {isRoot && descCount > 0 && (
          <span className="text-xs text-muted-foreground shrink-0 hidden lg:block">
            +{descCount}
          </span>
        )}

        {/* Span ID */}
        <span className="font-mono text-[10px] text-muted-foreground/40 shrink-0 w-20 text-right hidden xl:block truncate">
          {node.id.slice(0, 12)}
        </span>

        {/* Latency mini-bar */}
        <div className="relative h-1 w-16 shrink-0 rounded-full bg-muted overflow-hidden hidden lg:block">
          <div
            className={`absolute left-0 top-0 h-full rounded-full ${hasErr ? 'bg-red-400/50' : 'bg-primary/40'}`}
            style={{ width: `${barPct}%` }}
          />
        </div>

        {/* Latency */}
        <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0 w-14 text-right">
          {latLabel}
        </span>

        {/* Tokens */}
        <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0 w-14 text-right hidden lg:block">
          {(node.tokens_in + node.tokens_out).toLocaleString()}
        </span>

        {/* Cost */}
        <span className="text-xs font-mono tabular-nums text-foreground font-semibold shrink-0 w-16 text-right">
          ${node.cost.toFixed(4)}
        </span>

        {/* Status pill */}
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${
          hasErr
            ? 'bg-red-500/10 text-red-500'
            : 'bg-emerald-500/10 text-emerald-600'
        }`}>
          {hasErr ? 'ERROR' : 'OK'}
        </span>
      </div>

      {/* Children */}
      {expanded && hasKids && node.children.map(c => (
        <SpanRow
          key={c.id}
          node={c}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          maxDuration={maxDuration}
          isNew={false}
        />
      ))}
    </div>
  )
}

// ─── Detail drawer ────────────────────────────────────────────────────────────

function DetailDrawer({ span, onClose }: { span: Span; onClose: () => void }) {
  const ok = !span.error

  const prettyJson = (raw: string) => {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div
        className="w-[420px] max-w-full bg-background border-l border-border overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-background border-b border-border px-5 py-4 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <KindBadge kind={span.kind} />
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-500'}`}>
                {ok ? 'SUCCESS' : 'ERROR'}
              </span>
            </div>
            <h2 className={`text-base font-semibold truncate ${ok ? 'text-foreground' : 'text-red-500'}`}>
              {span.function_name || span.function}
            </h2>
            <p className="font-mono text-[10px] text-muted-foreground mt-0.5 break-all">{span.id}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-muted transition-colors shrink-0">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 p-5 space-y-5 overflow-y-auto">
          {/* Error */}
          {!ok && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <p className="text-xs font-semibold text-red-500 mb-1 uppercase tracking-wide">Error</p>
              <pre className="text-xs text-red-500 break-all whitespace-pre-wrap font-mono">{span.error}</pre>
            </div>
          )}

          {/* Metrics */}
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Latency', span.duration >= 1000 ? `${(span.duration/1000).toFixed(2)}s` : `${span.duration}ms`],
              ['Tokens', (span.tokens_in + span.tokens_out).toLocaleString()],
              ['Cost',   `$${span.cost.toFixed(5)}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-muted/20 p-3 text-center">
                <p className="text-sm font-bold font-mono text-foreground tabular-nums">{value}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {/* Arguments */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Input</p>
            <pre className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-foreground font-mono overflow-auto max-h-44 whitespace-pre-wrap break-all">
              {prettyJson(span.args)}
            </pre>
          </div>

          {/* Output */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Output</p>
            <pre className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-foreground font-mono overflow-auto max-h-44 whitespace-pre-wrap break-all">
              {prettyJson(span.output)}
            </pre>
          </div>

          {/* Details table */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">Details</p>
            <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
              {([
                ['Span ID',      span.id],
                ['Parent ID',    span.parent_id ?? '(root)'],
                ['Timestamp',    new Date(span.timestamp).toLocaleString()],
                ['Input tokens', span.tokens_in.toLocaleString()],
                ['Output tokens',span.tokens_out.toLocaleString()],
                ['Total tokens', (span.tokens_in + span.tokens_out).toLocaleString()],
                ['Cost',         `$${span.cost.toFixed(6)}`],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex items-start gap-4 px-3 py-2 bg-muted/10">
                  <span className="text-[11px] text-muted-foreground shrink-0 w-28">{k}</span>
                  <span className="text-[11px] font-mono text-foreground break-all">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TracesPage() {
  const [spans,       setSpans]       = useState<Span[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(false)
  const [search,      setSearch]      = useState('')
  const [filter,      setFilter]      = useState<'all' | 'success' | 'error'>('all')
  const [liveMode,    setLiveMode]    = useState(false)
  const [selected,    setSelected]    = useState<Span | null>(null)
  const [newIds,      setNewIds]      = useState<Set<string>>(new Set())
  const [realtimeOk,  setRealtimeOk]  = useState(false)
  const supaRef = useRef<SupabaseClient | null>(null)

  // Initial fetch
  useEffect(() => {
    let alive = true
    fetchTraces()
      .then(res => {
        if (!alive) return
        setSpans(res?.traces ?? [])
        setError(!res)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError(true)
        setLoading(false)
      })
    return () => { alive = false }
  }, [])

  // Supabase Realtime
  useEffect(() => {
    if (!liveMode || !supabaseUrl || !supabaseAnon) return
    const sb = createClient(supabaseUrl, supabaseAnon)
    supaRef.current = sb

    const channel = sb
      .channel('traces-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'traces' }, (payload: any) => {
        const r = payload.new
        const newSpan: Span = {
          id:            r.id,
          parent_id:     r.parent_id ?? null,
          function:      r.function || r.function_name || 'unknown',
          function_name: r.function || r.function_name || 'unknown',
          kind:          r.kind ?? null,
          status:        r.error ? 'ERROR' : 'SUCCESS',
          duration:      Math.round((r.latency_sec || 0) * 1000),
          tokens_in:     r.input_tokens  || 0,
          tokens_out:    r.output_tokens || 0,
          cost:          r.cost_usd || 0,
          timestamp:     r.timestamp || new Date().toISOString(),
          args:          r.args   || '{}',
          output:        r.output || '{}',
          error:         r.error  || null,
        }
        setSpans(prev => [newSpan, ...prev].slice(0, 500))
        setNewIds(prev => new Set([...prev, r.id]))
        setTimeout(() => setNewIds(prev => { const s = new Set(prev); s.delete(r.id); return s }), 3000)
      })
      .subscribe((status: string) => setRealtimeOk(status === 'SUBSCRIBED'))

    return () => { sb.removeChannel(channel); setRealtimeOk(false) }
  }, [liveMode])

  // Filter
  const filtered = useMemo(() => spans.filter(s => {
    const q = search.toLowerCase()
    if (q && !s.function_name.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) return false
    if (filter === 'success' && s.status !== 'SUCCESS') return false
    if (filter === 'error'   && s.status !== 'ERROR')   return false
    return true
  }), [spans, search, filter])

  const roots      = useMemo(() => buildTree(filtered), [filtered])
  const maxDuration = useMemo(() => Math.max(...filtered.map(s => s.duration), 1), [filtered])
  const errorCount  = filtered.filter(s => s.status === 'ERROR').length

  return (
    <DashboardLayout>
      <PageHeader
        title="Traces"
        description="Hierarchical span tree — click any row to inspect"
        status={{ label: liveMode ? (realtimeOk ? 'Live' : 'Connecting…') : 'Paused', variant: liveMode && realtimeOk ? 'active' : 'idle' }}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 pl-8 pr-3 rounded-md text-xs border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-40"
              />
            </div>
            {(['all', 'success', 'error'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`h-8 px-3 rounded-md text-xs font-medium capitalize transition-colors ${
                  filter === f ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:text-foreground'
                }`}>
                {f}
              </button>
            ))}
            <button
              onClick={() => setLiveMode(v => !v)}
              className={`flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border transition-colors ${
                liveMode ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${liveMode && realtimeOk ? 'bg-emerald-400 animate-pulse' : 'bg-current opacity-50'}`} />
              {liveMode ? 'Live' : 'Go Live'}
            </button>
          </div>
        }
      />

      <div className="p-5 space-y-4">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Tree */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border bg-muted/30 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            <div className="w-4 shrink-0" />
            <div className="w-1.5 shrink-0" />
            <div className="w-14 shrink-0" />
            <div className="flex-1">Span / Function</div>
            <div className="w-14 text-right hidden lg:block">ID</div>
            <div className="w-16 hidden lg:block" />
            <div className="w-14 text-right">Latency</div>
            <div className="w-14 text-right hidden lg:block">Tokens</div>
            <div className="w-16 text-right">Cost</div>
            <div className="w-14 shrink-0" />
          </div>

          {loading ? (
            <div className="divide-y divide-border">
              {Array(6).fill(0).map((_, i) => <SkeletonTableRow key={i} />)}
            </div>
          ) : roots.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {spans.length === 0 ? 'No traces yet. Enable Live to stream from Supabase.' : 'No spans match your filters.'}
            </div>
          ) : (
            roots.map(root => (
              <SpanRow
                key={root.id}
                node={root}
                depth={0}
                selected={selected}
                onSelect={setSelected}
                maxDuration={maxDuration}
                isNew={newIds.has(root.id)}
              />
            ))
          )}
        </div>

        {/* Summary bar */}
        {!loading && spans.length > 0 && (
          <p className="text-xs text-muted-foreground text-right">
            {filtered.length} span{filtered.length !== 1 ? 's' : ''}
            {errorCount > 0 && <span className="ml-2 text-red-500">· {errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
            {filtered.length !== spans.length && ` (of ${spans.length})`}
          </p>
        )}
      </div>

      {selected && <DetailDrawer span={selected} onClose={() => setSelected(null)} />}
    </DashboardLayout>
  )
}
