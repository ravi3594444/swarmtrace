'use client'

import { useMemo, useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { SwarmLoadingScreen } from '@/components/swarm/LoadingScreen'
import { similarity, lineDiff } from '@/lib/text-compare'
import type { Trace } from '@/lib/trace-types'
import { GitCompareArrows } from 'lucide-react'

const REGRESSION_THRESHOLD = 0.6

function traceLabel(t: Trace) {
  const time = new Date(t.timestamp).toISOString().slice(11, 19)
  return `${t.function} · ${t.id.slice(0, 8)} · ${time}`
}

function TracePicker({
  label, traces, value, onChange,
}: {
  label: string
  traces: Trace[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div className="flex-1 min-w-0">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
      >
        {traces.map((t) => (
          <option key={t.id} value={t.id}>{traceLabel(t)}</option>
        ))}
      </select>
    </div>
  )
}

function OutputPanel({ title, trace }: { title: string; trace: Trace | undefined }) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="border-b border-border bg-muted/30 px-4 py-2.5 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {trace && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {(trace.latency_sec ?? 0).toFixed(2)}s · ${(trace.cost_usd ?? 0).toFixed(4)}
          </span>
        )}
      </div>
      <pre className="p-4 text-xs text-foreground/90 whitespace-pre-wrap break-words font-mono max-h-[420px] overflow-auto">
        {trace?.output || <span className="text-muted-foreground italic">no output</span>}
      </pre>
    </div>
  )
}

export default function ComparePage() {
  const { traces, loading } = useSwarmTraces(10000)
  const [idA, setIdA] = useState('')
  const [idB, setIdB] = useState('')

  // Seed defaults once traces arrive: pick two most recent distinct traces.
  useEffect(() => {
    if (!idA && traces[0]) setIdA(traces[0].id)
    if (!idB && traces[1]) setIdB(traces[1].id)
  }, [traces, idA, idB])

  const traceA = useMemo(() => traces.find((t) => t.id === idA), [traces, idA])
  const traceB = useMemo(() => traces.find((t) => t.id === idB), [traces, idB])

  const score = useMemo(
    () => (traceA && traceB ? similarity(traceA.output, traceB.output) : null),
    [traceA, traceB]
  )
  const diff = useMemo(
    () => (traceA && traceB ? lineDiff(traceA.output, traceB.output) : []),
    [traceA, traceB]
  )

  if (loading) return (
    <DashboardLayout>
      <SwarmLoadingScreen message="Loading traces to compare…" />
    </DashboardLayout>
  )

  const regressed = score !== null && score < REGRESSION_THRESHOLD
  const pct = score !== null ? Math.round(score * 100) : 0

  return (
    <DashboardLayout>
      <PageHeader title="Compare" description="Diff two runs and score output similarity" />

      <div className="p-6 space-y-6">
        {traces.length < 2 ? (
          <div className="rounded-xl border border-border bg-card py-20 text-center shadow-sm">
            <GitCompareArrows className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <div className="text-sm font-semibold text-foreground">Need at least two traces to compare</div>
            <div className="text-xs text-muted-foreground mt-1">Run your agent a couple of times, then come back.</div>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4">
                <TracePicker label="Baseline (A)" traces={traces} value={idA} onChange={setIdA} />
                <GitCompareArrows className="hidden sm:block w-5 h-5 text-muted-foreground mb-2 shrink-0" />
                <TracePicker label="Candidate (B)" traces={traces} value={idB} onChange={setIdB} />
              </div>

              {score !== null && (
                <div className="mt-5 flex items-center gap-4">
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${regressed ? 'bg-red-400' : 'bg-emerald-400'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">{pct}%</span>
                  <span className={`rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${regressed ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
                    {regressed ? 'Regression' : 'OK'}
                  </span>
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Similarity is a Sørensen–Dice score over word bigrams. Below {Math.round(REGRESSION_THRESHOLD * 100)}% is flagged as a possible regression.
              </p>
            </div>

            <div className="flex flex-col lg:flex-row gap-4">
              <OutputPanel title="Baseline (A)" trace={traceA} />
              <OutputPanel title="Candidate (B)" trace={traceB} />
            </div>

            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
              <div className="border-b border-border bg-muted/30 px-4 py-2.5">
                <h3 className="text-xs font-semibold text-foreground">Line diff</h3>
              </div>
              <div className="p-2 font-mono text-xs max-h-[420px] overflow-auto">
                {diff.length === 0 ? (
                  <div className="px-2 py-4 text-muted-foreground italic">No output to diff.</div>
                ) : (
                  diff.map((line, i) => (
                    <div
                      key={i}
                      className={`px-2 py-0.5 whitespace-pre-wrap break-words ${
                        line.type === 'added'
                          ? 'bg-emerald-50 text-emerald-800'
                          : line.type === 'removed'
                          ? 'bg-red-50 text-red-800'
                          : 'text-foreground/80'
                      }`}
                    >
                      <span className="select-none text-muted-foreground mr-2">
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                      </span>
                      {line.text || '\u00a0'}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
