'use client'

import { useState, useEffect, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { StatBar } from '@/components/swarm/StatBar'
import { CallTree } from '@/components/swarm/CallTree'
import { TokenChart } from '@/components/swarm/TokenChart'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { FirstRunEmptyState, isFirstRun, markHasTraces } from '@/components/first-run-empty-state'
import LiveActivity from '@/components/LiveActivity'
import type { Trace } from '@/lib/trace-types'
import { filterTracesByRange, rangeStartMs } from '@/lib/trace-utils'
import { tracesToCsv, downloadCsv, downloadJson } from '@/lib/csv-export'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import { fetchOverview } from '@/lib/api'
import { TruncationBanner } from '@/components/truncation-banner'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import {
  Activity, ChevronDown, ChevronUp, Info, Coins, TrendingDown,
  Download, FileJson, FileText, TrendingUp, GitCompare, CheckCircle, AlertCircle,
} from 'lucide-react'
import { useIntegrations } from '@/contexts/IntegrationsContext'
import { chartTooltip } from '@/lib/chart-tooltip'

type OverviewEvent = { timestamp: string; type: string; message: string }

const RECENT_ACTIVITY_MS = 5 * 60 * 1000

function EventRow({ type, message }: { type: string; message: string }) {
  const [expanded, setExpanded] = useState(false)
  const isDense = message.length > 64
  const isAlert = type === 'ERROR' || type === 'WARN'

  return (
    <button
      onClick={() => isDense && setExpanded((v) => !v)}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 ${isDense ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase mt-0.5 ${isAlert ? 'bg-red-50 dark:bg-red-950/30 text-destructive border-red-200 dark:border-red-900/60' : 'bg-muted text-muted-foreground border-border'}`}>
        {type}
      </span>
      <p className={`text-xs text-foreground leading-relaxed min-w-0 flex-1 font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>
        {message}
      </p>
      {isDense && (
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      )}
    </button>
  )
}

/** Small agent selector shown above LiveActivity when >1 agent is active */
function AgentPicker({ agents, selected, onSelect }: {
  agents: { id: string; name: string }[]
  selected: string
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = agents.find((a) => a.id === selected)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="max-w-[120px] truncate">{current?.name ?? selected}</span>
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => { onSelect(a.id); setOpen(false) }}
              className={`w-full px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60
                ${a.id === selected ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Export helpers ─────────────────────────────────────────────────────────────

function exportJSON(traces: Trace[]) {
  // Guard against empty data — without this, the user could download a
  // file containing just "[]" (no traces). The menu button is also
  // disabled when there's no data, but this is belt-and-suspenders.
  if (traces.length === 0) return
  downloadJson(JSON.stringify(traces, null, 2), `swarmtrace-export-${new Date().toISOString().slice(0, 10)}.json`)
}

function exportCSV(traces: Trace[]) {
  // Guard against empty data — without this, the user could download a
  // CSV containing only the header row (no data rows).
  if (traces.length === 0) return
  // tracesToCsv() in lib/csv-export.ts sanitizes every cell against
  // formula injection (=, +, -, @, tab, CR prefixes) — see the audit
  // finding documented there.
  const csv = tracesToCsv(traces)
  downloadCsv(csv, `swarmtrace-export-${new Date().toISOString().slice(0, 10)}.csv`)
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

// ── Cost Projection Widget ─────────────────────────────────────────────────────

function CostProjectionWidget({ traces }: { traces: Trace[] }) {
  const { hourly, daily, monthly, windowHours } = useMemo(() => {
    if (traces.length === 0) return { hourly: 0, daily: 0, monthly: 0, windowHours: 0 }
    // Derive the time window from the traces themselves (newest - oldest),
    // NOT from Date.now(). Date.now() is impure — calling it inside useMemo
    // violates React's purity rules and would produce unstable results.
    // Using the trace timestamps makes this a pure function of `traces`.
    const timestamps = traces.map(t => new Date(t.timestamp).getTime())
    const newest = Math.max(...timestamps)
    const oldest = Math.min(...timestamps)
    const windowMs = Math.max(newest - oldest, 60_000) // at least 1 min
    const windowHours = windowMs / 3_600_000
    const totalCost = traces.reduce((s, t) => s + (t.cost_usd ?? 0), 0)
    const hourly = totalCost / windowHours
    return {
      hourly,
      daily: hourly * 24,
      monthly: hourly * 24 * 30,
      windowHours,
    }
  }, [traces])

  const fmt = (v: number) =>
    v < 0.01 ? `$${v.toFixed(6)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <TrendingUp className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Cost Projection</h3>
        <span className="ml-auto text-[11px] text-muted-foreground">
          based on last {windowHours < 1 ? `${Math.round(windowHours * 60)}m` : `${windowHours.toFixed(1)}h`}
        </span>
      </div>
      <div className="p-4">
        {traces.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No traces yet — run some agent calls to see cost projections.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: 'Per Hour', value: fmt(hourly), sub: 'current rate' },
              { label: 'Per Day', value: fmt(daily), sub: '24h projection' },
              { label: 'Per Month', value: fmt(monthly), sub: '30d projection' },
            ].map(({ label, value, sub }) => (
              <div key={label} className="rounded-lg border border-border bg-muted/20 p-3 text-center">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
                <div className="font-mono text-sm font-bold text-foreground">{value}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Trace Diff / Regression Compare View ──────────────────────────────────────

function TraceDiffPanel({ traces }: { traces: Trace[] }) {
  const [fnFilter, setFnFilter] = useState('')
  const [baseId, setBaseId] = useState('')
  const [candId, setCandId] = useState('')
  const [open, setOpen] = useState(false)

  // Unique function names for the filter
  const fnNames = useMemo(() => {
    const s = new Set(traces.map(t => t.function))
    return Array.from(s).sort()
  }, [traces])

  const candidates = useMemo(() =>
    traces.filter(t => !fnFilter || t.function === fnFilter),
    [traces, fnFilter])

  const base = traces.find(t => t.id === baseId)
  const cand = traces.find(t => t.id === candId)

  const similarity = useMemo(() => {
    if (!base || !cand) return null
    const a = (base.output ?? '').toLowerCase()
    const b = (cand.output ?? '').toLowerCase()
    if (!a && !b) return 1
    if (!a || !b) return 0
    // Jaccard similarity on word sets as a lightweight client-side heuristic
    const setA = new Set(a.split(/\s+/))
    const setB = new Set(b.split(/\s+/))
    const inter = [...setA].filter(w => setB.has(w)).length
    const union = new Set([...setA, ...setB]).size
    return union === 0 ? 1 : inter / union
  }, [base, cand])

  const latDiff = base && cand
    ? ((cand.latency_sec ?? 0) - (base.latency_sec ?? 0))
    : null

  const costDiff = base && cand
    ? ((cand.cost_usd ?? 0) - (base.cost_usd ?? 0))
    : null

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full border-b border-border bg-muted/30 px-4 py-3 text-left"
      >
        <GitCompare className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Trace Diff</h3>
        <span className="ml-1.5 text-[10px] text-muted-foreground">Compare two spans for regressions</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {/* Function filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground shrink-0">Function:</label>
            <select
              value={fnFilter}
              onChange={e => { setFnFilter(e.target.value); setBaseId(''); setCandId('') }}
              className="flex-1 h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">All functions</option>
              {fnNames.map(fn => <option key={fn} value={fn}>{fn}</option>)}
            </select>
          </div>

          {/* Span selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              { label: 'Baseline span', value: baseId, set: setBaseId },
              { label: 'Candidate span', value: candId, set: setCandId },
            ] as const).map(({ label, value, set }) => (
              <div key={label}>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
                <select
                  value={value}
                  onChange={e => set(e.target.value)}
                  className="w-full h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— pick a span —</option>
                  {candidates.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.function} · {t.id.slice(0, 8)} · {new Date(t.timestamp).toLocaleTimeString()}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* Diff result */}
          {base && cand && (
            <div className="space-y-3">
              {/* Metrics comparison */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[
                  {
                    label: 'Similarity',
                    value: similarity != null ? `${(similarity * 100).toFixed(0)}%` : '—',
                    ok: similarity != null && similarity >= 0.6,
                    icon: similarity != null && similarity >= 0.6 ? CheckCircle : AlertCircle,
                  },
                  {
                    label: 'Latency Δ',
                    value: latDiff != null ? `${latDiff >= 0 ? '+' : ''}${latDiff.toFixed(3)}s` : '—',
                    ok: latDiff != null && latDiff <= 0,
                    icon: latDiff != null && latDiff <= 0 ? CheckCircle : AlertCircle,
                  },
                  {
                    label: 'Cost Δ',
                    value: costDiff != null ? `${costDiff >= 0 ? '+' : ''}$${Math.abs(costDiff).toFixed(6)}` : '—',
                    ok: costDiff != null && costDiff <= 0,
                    icon: costDiff != null && costDiff <= 0 ? CheckCircle : AlertCircle,
                  },
                ].map(({ label, value, ok, icon: Icon }) => (
                  <div key={label} className={`rounded-lg border p-2.5 text-center ${ok ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30' : 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30'}`}>
                    <Icon className={`w-3.5 h-3.5 mx-auto mb-1 ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`} />
                    <div className={`font-mono text-xs font-bold ${ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>{value}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                  </div>
                ))}
              </div>

              {/* Side-by-side output diff */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { label: 'Baseline output', content: base.output, err: base.error },
                  { label: 'Candidate output', content: cand.output, err: cand.error },
                ].map(({ label, content, err }) => (
                  <div key={label}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
                    <pre className={`rounded-lg border p-2.5 text-[10px] font-mono leading-relaxed overflow-auto max-h-40 whitespace-pre-wrap break-all
                      ${err ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400' : 'border-border bg-muted/20 text-foreground'}`}>
                      {err ? `ERROR: ${err}` : (content || '(empty)')}
                    </pre>
                  </div>
                ))}
              </div>

              {/* Regression verdict */}
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold
                ${similarity != null && similarity < 0.6
                  ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
                  : 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'}`}>
                {similarity != null && similarity < 0.6
                  ? <><AlertCircle className="w-3.5 h-3.5" /> Regression detected — similarity below 60% threshold</>
                  : <><CheckCircle className="w-3.5 h-3.5" /> No regression — outputs are sufficiently similar</>}
              </div>
            </div>
          )}

          {!base && !cand && (
            <p className="text-xs text-muted-foreground text-center py-2">
              Select a baseline and candidate span above to compare outputs, latency, and cost.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Integration Panels ────────────────────────────────────────────────────────

function TokenBudgetPanel({ traces }: { traces: Trace[] }) {
  const agentTokens = useMemo(() => {
    const map = new Map<string, { id: string; name: string; input: number; output: number; calls: number }>()
    for (const t of traces) {
      const key = t.agent_id || t.agent_name || ''
      if (!key) continue
      const e = map.get(key) || { id: key, name: t.agent_name || key, input: 0, output: 0, calls: 0 }
      e.input += t.input_tokens ?? 0; e.output += t.output_tokens ?? 0; e.calls++
      map.set(key, e)
    }
    return Array.from(map.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output))
  }, [traces])

  const maxTotal = Math.max(1, agentTokens[0] ? agentTokens[0].input + agentTokens[0].output : 0)

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <Coins className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Token Budget Monitor</h3>
        <span className="ml-1.5 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />ACTIVE
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">per agent · all time</span>
      </div>
      <div className="p-4">
        {agentTokens.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No agent token data yet — tag your agents with <code className="font-mono text-xs bg-muted px-1 rounded">agent_name</code> in the SDK.
          </p>
        ) : (
          <div className="space-y-3">
            {agentTokens.slice(0, 5).map(a => {
              const total = a.input + a.output
              const pct = Math.round((total / maxTotal) * 100)
              return (
                <div key={a.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-foreground truncate max-w-[60%]">{a.name}</span>
                    <span className="text-xs text-muted-foreground">{total.toLocaleString()} tokens</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex gap-3 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">↑ {a.input.toLocaleString()} in</span>
                    <span className="text-[10px] text-muted-foreground">↓ {a.output.toLocaleString()} out</span>
                    <span className="text-[10px] text-muted-foreground">{a.calls} calls</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function RegressionPanel({ traces }: { traces: Trace[] }) {
  // Group by function and flag high-variance latency as potential regressions
  const riskFns = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const t of traces) {
      if (t.latency_sec == null) continue
      const arr = map.get(t.function) || []
      arr.push(t.latency_sec)
      map.set(t.function, arr)
    }
    return Array.from(map.entries())
      .filter(([, lats]) => lats.length >= 3)
      .map(([fn, lats]) => {
        const avg = lats.reduce((a, b) => a + b, 0) / lats.length
        const variance = lats.reduce((a, b) => a + (b - avg) ** 2, 0) / lats.length
        const cv = avg > 0 ? Math.sqrt(variance) / avg : 0
        return { fn, cv, avg, calls: lats.length }
      })
      .filter(r => r.cv > 0.4)
      .sort((a, b) => b.cv - a.cv)
      .slice(0, 3)
  }, [traces])

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <TrendingDown className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Regression Monitor</h3>
        <span className={`ml-1.5 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${riskFns.length > 0 ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20' : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${riskFns.length > 0 ? 'bg-yellow-500' : 'bg-green-500'}`} />
          {riskFns.length > 0 ? `${riskFns.length} AT RISK` : 'ALL CLEAR'}
        </span>
      </div>
      <div className="p-4">
        {riskFns.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            {traces.length === 0
              ? 'No traces yet — run some agent calls to start monitoring latency.'
              : `No regressions detected across ${traces.length} trace${traces.length !== 1 ? 's' : ''}.`}
          </p>
        ) : (
          <div className="space-y-2">
            {riskFns.map(r => (
              <div key={r.fn} className="flex items-center justify-between p-2.5 bg-yellow-500/5 border border-yellow-500/20 rounded-lg">
                <div className="min-w-0">
                  <p className="text-xs font-mono font-medium text-foreground truncate">{r.fn}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{r.calls} calls · avg {r.avg.toFixed(2)}s</p>
                </div>
                <span className="text-xs font-semibold text-yellow-600 dark:text-yellow-400 ml-3 shrink-0">CV {(r.cv * 100).toFixed(0)}%</span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground pt-1">High coefficient of variation (CV &gt; 40%) signals unstable latency.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default function OverviewPage() {
  const { traces, loading, isLive } = useSwarmTraces(10000)
  const { isEnabled } = useIntegrations()
  const { range, setRange } = useTimeRange()
  const [selected, setSelected] = useState<Trace | null>(null)
  const [activity, setActivity] = useState<{ time: string; requests: number }[]>([])
  const [events, setEvents] = useState<OverviewEvent[]>([])
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Single source of truth for the time-windowed view: filter the polled
  // traces once by the selected range, then hand the filtered array to every
  // downstream widget. Defaults to "Today" so the dashboard no longer shows
  // all-time data on load. Recomputes only when `traces` or `range` change.
  const filteredTraces = useMemo(
    () => filterTracesByRange(traces, range),
    [traces, range],
  )

  const filteredEvents = useMemo(() => {
    const start = rangeStartMs(range)
    if (start == null) return events
    return events.filter((e) => {
      const ms = new Date(e.timestamp).getTime()
      return Number.isFinite(ms) && ms >= start
    })
  }, [events, range])

  // Fetch overview data (activity chart + events feed). Tracks lastUpdated
  // for the PageHeader timestamp + manual refresh.
  const loadOverview = () => {
    fetchOverview().then((d) => {
      if (!d) return
      if (d.activity?.length) setActivity(d.activity)
      if (d.events?.length) setEvents(d.events)
      setTruncated(Boolean(d.truncated))
      setLastUpdated(new Date())
    })
  }
  useEffect(() => {
    loadOverview()
    const id = setInterval(loadOverview, 30_000)
    return () => clearInterval(id)
  }, [])

  // Keep relative "live"/"idle" status current even if no new trace
  // arrives. This mirrors the polling cadence and avoids leaving an old
  // activity badge marked LIVE forever.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Derive unique agents from the currently selected time range. Stats and
  // charts already use filteredTraces; using all traces here made an old
  // agent appear in the "Today" Live Activity card even when Today had
  // zero traces.
  const activeAgents = useMemo(() => {
    const seen = new Map<string, string>()
    filteredTraces.forEach((t) => {
      if (t.agent_id && !seen.has(t.agent_id)) {
        seen.set(t.agent_id, t.agent_name ?? t.agent_id)
      }
    })
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  }, [filteredTraces])

  const [pickedAgent, setPickedAgent] = useState<string>('')

  // Derive the effective agent WITHOUT a set-state-in-effect. If the user
  // has picked one and it's still active, use it; otherwise default to the
  // most recently active agent. This replaces the old useEffect that called
  // setPickedAgent synchronously (cascading-render lint violation).
  const effectiveAgent =
    pickedAgent && activeAgents.find((a) => a.id === pickedAgent)
      ? pickedAgent
      : activeAgents[0]?.id ?? ''

  const hasRealtime = activeAgents.length > 0 && !!effectiveAgent

  const latestFilteredTraceMs = useMemo(() => {
    let latest: number | null = null
    for (const t of filteredTraces) {
      const ms = new Date(t.timestamp).getTime()
      if (!Number.isFinite(ms)) continue
      latest = latest == null ? ms : Math.max(latest, ms)
    }
    return latest
  }, [filteredTraces])
  const hasRecentActivity =
    latestFilteredTraceMs != null && nowMs - latestFilteredTraceMs <= RECENT_ACTIVITY_MS
  const overviewLiveStatus = hasRecentActivity
    ? 'live'
    : filteredTraces.length > 0 ? 'paused' : 'offline'
  const activityBadge = hasRecentActivity
    ? { label: 'LIVE', dot: 'bg-emerald-500 swarm-pulse' }
    : filteredTraces.length > 0
      ? { label: 'IDLE', dot: 'bg-amber-400' }
      : { label: 'NO ACTIVITY', dot: 'bg-muted-foreground/50' }

  // First-run detection: if the user has never had traces (per localStorage),
  // show a rich onboarding empty state instead of the minimal "no traces" text.
  // Once traces appear, markHasTraces() sets the localStorage flag so this
  // empty state never shows again (even if they later clear their DB).
  //
  // Derivation pattern (no setState-in-effect): `firstRunChecked` is set once
  // on mount to signal "localStorage is safe to read" (it's unavailable during
  // SSR). `showFirstRun` is then derived from the current trace count + the
  // localStorage check — no cascading renders. The markHasTraces() side effect
  // runs when traces arrive but doesn't call setState.
  const [firstRunChecked, setFirstRunChecked] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration localStorage read; runs once.
    setFirstRunChecked(true)
  }, [])
  useEffect(() => {
    if (traces.length > 0) markHasTraces()
  }, [traces.length])
  const showFirstRun = firstRunChecked && !loading && traces.length === 0 && isFirstRun()

  if (loading) return (
    <DashboardSkeleton title="Overview" description="Live swarm health and execution summary" />
  )

  // First-run: show onboarding empty state with the 3-step setup guide.
  // Still wrapped in DashboardLayout so the sidebar + command palette work.
  if (showFirstRun) {
    return (
      <DashboardLayout>
        <PageHeader
          title="Overview"
          description="Live swarm health and execution summary"
        />
        <FirstRunEmptyState />
      </DashboardLayout>
    )
  }

  const errorCount = filteredTraces.filter((t) => t.error).length

  return (
    <DashboardLayout>
      <PageHeader
        title="Overview"
        description="Live swarm health and execution summary"
        liveStatus={isLive ? overviewLiveStatus : 'paused'}
        lastUpdated={lastUpdated}
        onRefresh={loadOverview}
        actions={
          <div className="flex items-center gap-3">
            <TimeRangeDropdown value={range} onChange={setRange} />
            <span className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />{filteredTraces.length - errorCount} ok</span>
              <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" />{errorCount} errors</span>
            </span>
            <ExportMenu traces={filteredTraces} />
          </div>
        }
      />

      {truncated && <TruncationBanner range="the last 24 hours" />}

      <div className="p-6 space-y-6">
        <StatBar traces={filteredTraces} />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Activity chart — 2/3 width */}
          <div className="xl:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Request Activity</h3>
              </div>
              <span className="text-[11px] text-muted-foreground">last 24h · hourly</span>
            </div>
            <div className="p-4 h-44">
              {activity.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No activity yet</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={activity} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.18} />
                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="time" tick={{ fill: 'var(--muted-foreground)', fontSize: 10, fontWeight: 500 }} axisLine={false} tickLine={false} interval={3} />
                    <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11, fontWeight: 500 }} axisLine={false} tickLine={false} width={32} />
                    <Tooltip {...chartTooltip} />
                    <Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#colorReq)" dot={false} activeDot={{ r: 4, fill: 'var(--primary)', stroke: 'var(--card)', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Live Activity — 1/3 width. Shows FOV realtime events if agent_id is available,
              falls back to the polled event feed for older SDK traces. */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden flex flex-col transition-[background-color,border-color,color] duration-200">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">
                  {hasRealtime
                    ? hasRecentActivity ? 'Live Activity' : 'Agent Activity'
                    : hasRecentActivity ? 'Live Events' : 'Events'}
                </h3>
              </div>
              {hasRealtime && activeAgents.length > 1 ? (
                <AgentPicker agents={activeAgents} selected={effectiveAgent} onSelect={setPickedAgent} />
              ) : (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${activityBadge.dot}`} />{activityBadge.label}
                </span>
              )}
            </div>

            {hasRealtime ? (
              <div className="flex-1 overflow-hidden min-h-0">
                <LiveActivity
                  agentId={effectiveAgent}
                  agentName={activeAgents.find((a) => a.id === effectiveAgent)?.name}
                />
              </div>
            ) : (
              <div className="divide-y divide-border/50 overflow-y-auto max-h-60">
                {(filteredEvents.length ? filteredEvents : filteredTraces.slice(0, 6).map((t) => ({
                  timestamp: t.timestamp,
                  type: t.error ? 'ERROR' : 'INFO',
                  message: t.error ? `${t.function}: ${t.error}` : `${t.function} completed in ${(t.latency_sec ?? 0).toFixed(2)}s`,
                }))).slice(0, 8).map((e, i) => (
                  <EventRow key={`${e.timestamp}-${i}`} type={e.type} message={e.message} />
                ))}
                {filteredEvents.length === 0 && filteredTraces.length === 0 && (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">No events in this time range</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Cost Projection Widget — always visible */}
        <CostProjectionWidget traces={filteredTraces} />

        {/* Trace Diff / Regression Compare */}
        <TraceDiffPanel traces={filteredTraces} />

        {/* Integration Panels — only rendered when integrations are enabled */}
        {(isEnabled('token-budget') || isEnabled('regression-detector')) && (
          <div className={`grid grid-cols-1 gap-6 ${isEnabled('token-budget') && isEnabled('regression-detector') ? 'xl:grid-cols-2' : ''}`}>
            {isEnabled('token-budget')        && <TokenBudgetPanel traces={filteredTraces} />}
            {isEnabled('regression-detector') && <RegressionPanel  traces={filteredTraces} />}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CallTree traces={filteredTraces} onSelect={setSelected} />
          <TokenChart traces={filteredTraces} />
        </div>
      </div>

      <DetailDrawer trace={selected} allTraces={filteredTraces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
