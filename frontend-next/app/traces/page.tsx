'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Search, X, AlertCircle } from 'lucide-react'
import { fetchTraces, formatTime } from '@/lib/api'
import { SkeletonTableRow } from '@/components/skeleton'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  || ''
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

const FALLBACK_TRACES = [
  {
    id: 'trace_1a2b3c4d',
    agent: 'DataExtractor_v2',
    function_name: 'extract_earnings',
    status: 'SUCCESS',
    duration: 234,
    tokens_in: 1250,
    tokens_out: 850,
    cost: 0.032,
    timestamp: '2024-01-15T14:32:01Z',
    args: '{"url": "https://example.com/earnings", "format": "json"}',
    output: '{"earnings": 45.2, "currency": "USD", "period": "Q3"}',
    error: null,
    parent_id: null,
  },
  {
    id: 'trace_5e6f7g8h',
    agent: 'CodeAnalyzer_Beta',
    function_name: 'analyze_code',
    status: 'SUCCESS',
    duration: 412,
    tokens_in: 2840,
    tokens_out: 1520,
    cost: 0.084,
    timestamp: '2024-01-15T14:28:45Z',
    args: '{"language": "python", "code_snippet": "def hello(): print()"}',
    output: '{"complexity": "O(1)", "issues": []}',
    error: null,
    parent_id: null,
  },
  {
    id: 'trace_9i0j1k2l',
    agent: 'LangRouter_EU',
    function_name: 'route_request',
    status: 'ERROR',
    duration: 1250,
    tokens_in: 892,
    tokens_out: 245,
    cost: 0.018,
    timestamp: '2024-01-15T14:25:32Z',
    args: '{"model": "gpt-4", "max_tokens": 500}',
    output: '{}',
    error: 'Timeout exceeded: 1250ms',
    parent_id: 'trace_5e6f7g8h',
  },
]

export default function TracesPage() {
  const [traces, setTraces]           = useState<any[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(false)
  const [search, setSearch]           = useState('')
  const [filter, setFilter]           = useState<'all' | 'success' | 'error'>('all')
  const [liveMode, setLiveMode]       = useState(false)
  const [selectedTrace, setSelectedTrace] = useState<any>(null)
  const [newRowIds, setNewRowIds]     = useState<Set<string>>(new Set())
  const [realtimeOk, setRealtimeOk]  = useState(false)
  const supaRef = useRef<SupabaseClient<any> | null>(null)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const result = await fetchTraces()
        if (isMounted) {
          setTraces(result?.traces || FALLBACK_TRACES)
          setError(!result)
          setLoading(false)
        }
      } catch (err) {
        if (isMounted) {
          console.error('[v0] Traces fetch failed:', err)
          setTraces(FALLBACK_TRACES)
          setError(true)
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      isMounted = false
    }
  }, [])

  // ── Supabase Realtime — replaces setInterval polling entirely ─────────────
  // When liveMode is on: subscribe to INSERT events on the traces table.
  // New row slides in instantly (~50ms) with a green highlight for 3 seconds.
  // Zero extra Vercel function calls — Supabase broadcasts over WebSocket.
  useEffect(() => {
    if (!liveMode || !supabaseUrl || !supabaseAnon) return

    const sb = createClient(supabaseUrl, supabaseAnon)
    supaRef.current = sb

    const channel = sb
      .channel('traces-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'traces' },
        (payload: any) => {
          const raw = payload.new
          // Normalise the incoming row to match the trace shape the table expects
          const newTrace = {
            id:            raw.id,
            function_name: raw.function_name || raw.function || 'unknown',
            status:        raw.error ? 'ERROR' : 'SUCCESS',
            duration:      Math.round((raw.latency_sec || 0) * 1000),
            tokens_in:     raw.input_tokens  || 0,
            tokens_out:    raw.output_tokens || 0,
            cost:          raw.cost_usd  || 0,
            timestamp:     raw.timestamp || new Date().toISOString(),
            args:          raw.args      || '',
            output:        raw.output    || '',
            error:         raw.error     || null,
            parent_id:     raw.parent_id || null,
            kind:          raw.kind      || 'agent',
          }

          setTraces(prev => [newTrace, ...prev].slice(0, 200)) // cap at 200 rows
          setNewRowIds(prev => new Set([...prev, raw.id]))
          setTimeout(() => {
            setNewRowIds(prev => { const s = new Set(prev); s.delete(raw.id); return s })
          }, 3000)
        }
      )
      .subscribe((status: string) => setRealtimeOk(status === 'SUBSCRIBED'))

    return () => {
      sb.removeChannel(channel)
      setRealtimeOk(false)
    }
  }, [liveMode])

  const filtered = useMemo(() => {
    return traces.filter(t => {
      const matchesSearch = t.id.toLowerCase().includes(search.toLowerCase()) || t.function_name.toLowerCase().includes(search.toLowerCase())
      const matchesFilter = filter === 'all' || t.status.toLowerCase() === filter.toLowerCase()
      return matchesSearch && matchesFilter
    })
  }, [traces, search, filter])

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Traces</h1>
            <p className="text-muted-foreground">Detailed execution traces of individual agent runs and requests.</p>
          </div>
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full font-semibold text-sm transition-colors ${
              liveMode
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-container-high text-on-surface-variant'
            }`}
          >
            {liveMode ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${realtimeOk ? 'bg-green-300' : 'bg-primary-foreground'}`} />
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${realtimeOk ? 'bg-green-400' : 'bg-primary-foreground'}`} />
                </span>
                {realtimeOk ? 'Live' : 'Connecting…'}
              </>
            ) : '○ Live'}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="w-5 h-5 text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by trace ID or function name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 rounded-full bg-surface-container-low border border-outline text-on-surface placeholder-on-surface-variant focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'all'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilter('success')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'success'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Success
            </button>
            <button
              onClick={() => setFilter('error')}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                filter === 'error'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'
              }`}
            >
              Error
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-surface-container border border-outline rounded-2xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline bg-surface-container-high">
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Trace ID</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Function</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Status</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Duration</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Tokens</th>
                <th className="text-left px-6 py-4 text-sm font-semibold text-on-surface">Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array(5).fill(0).map((_, i) => <tr key={i}><td colSpan={6}><SkeletonTableRow /></td></tr>)
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-on-surface-variant">
                    No traces found
                  </td>
                </tr>
              ) : (
                filtered.map((trace) => (
                  <tr
                    key={trace.id}
                    onClick={() => setSelectedTrace(trace)}
                    className={`cursor-pointer hover:bg-surface-container-high/50 transition-all duration-500 border-b border-outline ${
                      newRowIds.has(trace.id) ? 'bg-primary/8 border-l-2 border-l-primary' : ''
                    }`}
                  >
                    <td className="px-6 py-4 text-on-surface text-sm font-mono">{trace.id}</td>
                    <td className="px-6 py-4 text-on-surface">{trace.function_name}</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                        trace.status === 'SUCCESS'
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {trace.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-on-surface">{trace.duration}ms</td>
                    <td className="px-6 py-4 text-on-surface">{trace.tokens_in + trace.tokens_out}</td>
                    <td className="px-6 py-4 text-on-surface-variant text-sm">{formatTime(trace.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Detail Drawer */}
        {selectedTrace && (
          <div className="fixed inset-0 bg-black/50 flex justify-end z-50">
            <div className="w-96 bg-surface-container border-l border-outline overflow-y-auto animate-in slide-in-from-right">
              <div className="sticky top-0 bg-surface-container border-b border-outline p-6 flex justify-between items-center">
                <h2 className="text-xl font-semibold text-on-surface">Trace Details</h2>
                <button onClick={() => setSelectedTrace(null)} className="p-1 hover:bg-surface-container-high rounded">
                  <X className="w-5 h-5 text-on-surface-variant" />
                </button>
              </div>

              <div className="p-6 space-y-6">
                <div>
                  <p className="text-xs text-on-surface-variant mb-2">TRACE ID</p>
                  <p className="text-sm font-mono text-on-surface break-all">{selectedTrace.id}</p>
                </div>

                <div>
                  <p className="text-xs text-on-surface-variant mb-2">FUNCTION</p>
                  <p className="text-sm text-on-surface">{selectedTrace.function_name}</p>
                </div>

                <div>
                  <p className="text-xs text-on-surface-variant mb-2">ARGUMENTS</p>
                  <pre className="bg-surface-container-low border border-outline rounded p-3 text-xs text-on-surface overflow-auto max-h-40 font-mono">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(selectedTrace.args), null, 2)
                      } catch {
                        return selectedTrace.args
                      }
                    })()}
                  </pre>
                </div>

                <div>
                  <p className="text-xs text-on-surface-variant mb-2">OUTPUT</p>
                  <pre className="bg-surface-container-low border border-outline rounded p-3 text-xs text-on-surface overflow-auto max-h-40 font-mono">
                    {selectedTrace.output || '{}'}
                  </pre>
                </div>

                {selectedTrace.error && (
                  <div className="bg-red-500/20 border border-red-500/30 rounded p-4">
                    <p className="text-xs text-red-400 font-semibold mb-1">ERROR</p>
                    <p className="text-sm text-red-400">{selectedTrace.error}</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-on-surface-variant mb-1">LATENCY</p>
                    <p className="text-sm font-semibold text-on-surface">{selectedTrace.duration}ms</p>
                  </div>
                  <div>
                    <p className="text-xs text-on-surface-variant mb-1">TOKENS IN</p>
                    <p className="text-sm font-semibold text-on-surface">{selectedTrace.tokens_in}</p>
                  </div>
                  <div>
                    <p className="text-xs text-on-surface-variant mb-1">TOKENS OUT</p>
                    <p className="text-sm font-semibold text-on-surface">{selectedTrace.tokens_out}</p>
                  </div>
                  <div>
                    <p className="text-xs text-on-surface-variant mb-1">COST</p>
                    <p className="text-sm font-semibold text-on-surface">${(selectedTrace.cost ?? 0).toFixed(4)}</p>
                  </div>
                </div>

                {selectedTrace.parent_id && (
                  <div>
                    <p className="text-xs text-on-surface-variant mb-2">PARENT ID</p>
                    <p className="text-sm font-mono text-on-surface break-all">{selectedTrace.parent_id}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
