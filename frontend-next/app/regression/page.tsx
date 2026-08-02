'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { formatRelativeTime } from '@/lib/api'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Clock, GitCompareArrows, Layers,
} from 'lucide-react'

interface RegressionResult {
  input: string
  output_a: string | null
  output_b: string | null
  latency_a_sec: number
  latency_b_sec: number
  similarity: number
  regressed: boolean
}

interface RegressionRun {
  id: string
  run_id: string
  name: string | null
  threshold: number
  version_a_prompt: string | null
  version_b_prompt: string | null
  inputs_count: number
  regressions_count: number
  duration_sec: number
  results: RegressionResult[]
  created_at: string
}

function SimilarityBar({ value, threshold }: { value: number; threshold: number }) {
  const pct = Math.round(value * 100)
  const regressed = value < threshold
  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${regressed ? 'bg-red-400' : 'bg-emerald-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-bold tabular-nums w-12 text-right ${regressed ? 'text-red-400' : 'text-emerald-400'}`}>
        {pct}%
      </span>
    </div>
  )
}

function RunCard({ run }: { run: RegressionRun }) {
  const [open, setOpen] = useState(true)
  const title = run.name || run.run_id.slice(0, 8)

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm transition-[background-color,border-color,color] duration-200 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground truncate">{title}</span>
            {run.regressions_count > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/30 px-2 py-0.5 text-[11px] font-bold text-red-400">
                <AlertTriangle className="w-3 h-3" />
                {run.regressions_count} REGRESSED
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
                <CheckCircle2 className="w-3 h-3" />
                CLEAN
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1 flex-wrap">
            <span>{formatRelativeTime(run.created_at)}</span>
            <span className="inline-flex items-center gap-1"><Layers className="w-3 h-3" />{run.inputs_count} inputs</span>
            <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{run.duration_sec.toFixed(1)}s</span>
            <span>threshold {run.threshold.toFixed(2)}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold tabular-nums text-foreground leading-none">
            {run.results.length > 0
              ? `${Math.round(run.results.reduce((s, r) => s + r.similarity, 0) / run.results.length * 100)}%`
              : '—'}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">avg similarity</div>
        </div>
      </button>

      {/* Per-input results */}
      {open && (
        <div className="border-t border-border divide-y divide-border/60">
          {run.results.length === 0 && (
            <div className="px-5 py-6 text-xs text-muted-foreground text-center">No per-input results stored for this run.</div>
          )}
          {run.results.map((r, i) => (
            <div key={i} className="px-5 py-3.5">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-xs font-mono text-foreground/80 max-w-[240px] sm:max-w-xs truncate" title={r.input}>
                  {r.input}
                </span>
                <SimilarityBar value={r.similarity} threshold={run.threshold} />
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  A {r.latency_a_sec.toFixed(2)}s · B {r.latency_b_sec.toFixed(2)}s
                </span>
                {r.regressed
                  ? <span className="text-[11px] font-bold text-red-400 shrink-0">🔴 REGRESSED</span>
                  : <span className="text-[11px] font-bold text-emerald-400 shrink-0">✅ OK</span>}
              </div>
              {(r.output_a || r.output_b) && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                  <pre className="rounded-lg bg-muted/40 p-2.5 text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono max-h-28 overflow-auto">
                    {r.output_a || <span className="italic text-muted-foreground">no output A</span>}
                  </pre>
                  <pre className="rounded-lg bg-muted/40 p-2.5 text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono max-h-28 overflow-auto">
                    {r.output_b || <span className="italic text-muted-foreground">no output B</span>}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RegressionPage() {
  const [runs, setRuns] = useState<RegressionRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/regression')
      if (!res.ok) {
        setError(`Failed to load regression runs (HTTP ${res.status})`)
        setRuns([])
        return
      }
      const data = await res.json()
      setRuns(Array.isArray(data.runs) ? data.runs : [])
      setError(null)
    } catch {
      setError('Could not reach the regression API.')
      setRuns([])
    }
  }, [])

  // Inline async IIFE inside the effect (matches the settings-page pattern)
  // so the initial setState happens in a microtask, never synchronously in
  // the effect body. `load` is reused by the Refresh button (event handler).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/regression')
        if (cancelled) return
        if (!res.ok) {
          setError(`Failed to load regression runs (HTTP ${res.status})`)
          setRuns([])
          return
        }
        const data = await res.json()
        if (cancelled) return
        setRuns(Array.isArray(data.runs) ? data.runs : [])
        setError(null)
      } catch {
        if (cancelled) return
        setError('Could not reach the regression API.')
        setRuns([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (runs === null && error === null) {
    return <DashboardSkeleton title="Regression" description="LLM-scored prompt regression runs" />
  }

  const totalInputs = runs?.reduce((s, r) => s + (r.inputs_count || 0), 0) ?? 0
  const totalRegressed = runs?.reduce((s, r) => s + (r.regressions_count || 0), 0) ?? 0
  const flaggedRuns = runs?.filter((r) => (r.regressions_count || 0) > 0).length ?? 0

  return (
    <DashboardLayout>
      <PageHeader
        title="Regression"
        description="LLM-scored prompt comparisons reported by the SDK"
        badge={runs && runs.length > 0 ? `${runs.length} RUNS` : undefined}
        actions={
          <button
            type="button"
            onClick={load}
            className="h-9 px-3 rounded-lg border border-border bg-card text-xs font-semibold text-foreground hover:bg-muted transition-colors"
          >
            Refresh
          </button>
        }
      />

      <div className="p-6 space-y-6">
        {runs && runs.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: 'Runs Reported', value: String(runs.length), sub: 'from compare(..., report_to_dashboard=True)' },
              { label: 'Inputs Evaluated', value: String(totalInputs), sub: 'across all reported runs' },
              { label: 'Regressions Flagged', value: String(totalRegressed), sub: `${flaggedRuns} run${flaggedRuns === 1 ? '' : 's'} with at least one`, icon: AlertTriangle },
            ].map(({ label, value, sub, icon: Icon }) => (
              <div key={label} className="rounded-xl border border-border bg-card p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
                  <span className="text-xs text-muted-foreground uppercase tracking-wider font-bold">{label}</span>
                </div>
                <div className="text-4xl font-bold text-foreground leading-none tracking-tight">{value}</div>
                <div className="text-xs text-muted-foreground mt-2.5">{sub}</div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-border bg-card p-5 text-sm text-red-400 shadow-sm">{error}</div>
        )}

        {runs && runs.length === 0 && !error && (
          <div className="rounded-xl border border-border bg-card py-16 px-6 text-center shadow-sm">
            <GitCompareArrows className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <div className="text-sm font-semibold text-foreground">No regression runs reported yet</div>
            <div className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              Run a prompt comparison in your agent with dashboard reporting enabled, then come back here.
            </div>
            <pre className="mt-4 mx-auto max-w-lg text-left rounded-lg bg-muted/50 p-3 text-[11px] text-foreground/80 font-mono overflow-x-auto">
{`from swarmtrace.regression import compare

compare(
    my_agent,
    inputs=["What is ML?"],
    version_a_prompt="You are a helpful assistant.",
    version_b_prompt="Reply only in emojis.",
    report_to_dashboard=True,
)`}
            </pre>
            <div className="text-[11px] text-muted-foreground mt-2">
              Requires <span className="font-mono">SWARMTRACE_API_KEY</span> (and optionally{' '}
              <span className="font-mono">SWARMTRACE_ENDPOINT</span>) to be set.
            </div>
          </div>
        )}

        {runs && runs.length > 0 && (
          <div className="space-y-4">
            {runs.map((run) => <RunCard key={run.id} run={run} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
