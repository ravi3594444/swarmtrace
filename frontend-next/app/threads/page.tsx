'use client'

import { useMemo, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { groupThreads, type Thread } from '@/lib/thread-grouping'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import type { Trace } from '@/lib/trace-types'
import { formatFullTime as formatTime } from '@/lib/format-time'
import { filterTracesByRange } from '@/lib/trace-utils'
import { ChevronRight, MessagesSquare, Clock3, Coins, Hash, AlertTriangle } from 'lucide-react'

function shortSessionId(sessionId: string) {
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
}

function outputSnippet(output: string) {
  const trimmed = output.trim()
  if (!trimmed) return 'no output'
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed
}

function ThreadCard({
  thread,
  open,
  onToggle,
  onSelect,
}: {
  thread: Thread
  open: boolean
  onToggle: () => void
  onSelect: (trace: Trace) => void
}) {
  const latest = thread.traces[thread.traces.length - 1]

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color,box-shadow] duration-200">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 text-[11px] font-semibold text-primary font-mono">
          {shortSessionId(thread.sessionId)}
        </span>
        <span className="flex-1 text-xs text-foreground/90 truncate font-mono">{thread.sessionId}</span>
        {thread.hasError ? (
          <span className="shrink-0 rounded-full border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-2 py-0.5 text-[11px] font-bold uppercase text-red-700 dark:text-red-400">Error</span>
        ) : (
          <span className="shrink-0 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400">OK</span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground hidden sm:inline">{formatTime(thread.firstSeen)} → {formatTime(thread.lastSeen)}</span>
        <span className="shrink-0 w-12 text-right text-sm font-bold text-foreground tabular-nums">{thread.turnCount}×</span>
      </button>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-px border-t border-border/60 bg-border/60">
        {[
          { label: 'Turns', value: thread.turnCount.toString(), icon: MessagesSquare },
          { label: 'Tokens', value: thread.totalTokens.toLocaleString(), icon: Hash },
          { label: 'Cost', value: `$${thread.totalCost.toFixed(4)}`, icon: Coins },
          { label: 'Latest', value: latest ? formatTime(latest.timestamp) : '—', icon: Clock3 },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="bg-card px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              <Icon className="w-3.5 h-3.5" />
              {label}
            </div>
            <div className="text-sm font-semibold text-foreground truncate">{value}</div>
          </div>
        ))}
      </div>

      {open && (
        <div className="border-t border-border/60 animate-slide-in-up">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 text-left">Time</th>
                <th className="px-4 py-2.5 text-left">Function</th>
                <th className="px-4 py-2.5 text-left">Output</th>
                <th className="px-4 py-2.5 text-right">Latency</th>
                <th className="px-4 py-2.5 text-right">Tokens</th>
                <th className="px-4 py-2.5 text-right">Cost</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {thread.traces.map((trace) => (
                <tr
                  key={trace.id}
                  onClick={() => onSelect(trace)}
                  className="cursor-pointer hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatTime(trace.timestamp)}</td>
                  <td className="px-4 py-3 text-sm font-medium text-foreground">{trace.function}</td>
                  <td className="px-4 py-3 text-xs text-foreground/90 max-w-sm truncate">{outputSnippet(trace.output)}</td>
                  <td className="px-4 py-3 text-xs font-mono tabular-nums text-right">{trace.latency_sec.toFixed(2)}s</td>
                  <td className="px-4 py-3 text-xs font-mono tabular-nums text-right">{(trace.input_tokens + trace.output_tokens).toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs font-mono tabular-nums text-right">${trace.cost_usd.toFixed(4)}</td>
                  <td className="px-4 py-3">
                    {trace.error ? (
                      <span className="inline-flex rounded-full border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-2 py-0.5 text-[11px] font-bold uppercase text-red-700 dark:text-red-400">Error</span>
                    ) : (
                      <span className="inline-flex rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 text-[11px] font-bold uppercase text-emerald-700 dark:text-emerald-400">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function ThreadsPage() {
  const { traces, loading } = useSwarmTraces(10000)
  const { range, setRange } = useTimeRange()
  const [selected, setSelected] = useState<Trace | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Filter to the selected time range before grouping into threads so old
  // conversations don't bury today's active ones. Range is shared with
  // Overview/Agents/Failures/Compare via localStorage, so picking "Today"
  // on the dashboard carries over here.
  const filteredTraces = useMemo(
    () => filterTracesByRange(traces, range),
    [traces, range],
  )

  const threads = useMemo(() => groupThreads(filteredTraces), [filteredTraces])
  const totalTurns = useMemo(() => threads.reduce((sum, thread) => sum + thread.turnCount, 0), [threads])
  const totalErrors = useMemo(() => threads.filter((thread) => thread.hasError).length, [threads])

  // DashboardSkeleton already renders DashboardLayout itself — don't wrap
  // it again or the sidebar renders twice while loading.
  if (loading) {
    return (
      <DashboardSkeleton title="Threads" description="Multi-turn agent conversations" />
    )
  }

  return (
    <DashboardLayout>
      <PageHeader
        title="Threads"
        description="Conversation sessions grouped by session id"
        badge={`${threads.length} THREADS`}
        actions={
          <TimeRangeDropdown value={range} onChange={setRange} />
        }
      />

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: 'Threads', value: String(threads.length), sub: 'distinct sessions', icon: MessagesSquare },
            { label: 'Turns', value: String(totalTurns), sub: 'trace entries with session ids', icon: Hash },
            { label: 'Error Threads', value: String(totalErrors), sub: 'sessions with at least one error', icon: AlertTriangle },
          ].map(({ label, value, sub, icon: Icon }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200">
              <div className="flex items-center gap-2 mb-3">
                <Icon className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-bold">{label}</span>
              </div>
              <div className="text-4xl font-bold text-foreground leading-none tracking-tight">{value}</div>
              <div className="text-xs text-muted-foreground mt-2.5">{sub}</div>
            </div>
          ))}
        </div>

        {threads.length === 0 ? (
          <div className="rounded-xl border border-border bg-card py-20 px-6 text-center shadow-sm">
            <MessagesSquare className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
            <div className="text-sm font-semibold text-foreground">No conversation threads yet</div>
            <div className="mt-2 text-sm text-muted-foreground max-w-2xl mx-auto space-y-1">
              <p>Start a thread by grouping calls with a session id.</p>
              <p>
                Python: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">with swarmtrace.session(&quot;conv-id&quot;): ...</code>{' '}
                or <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">@observe(session_id=&quot;conv-id&quot;)</code>
              </p>
              <p>
                Node: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">session(&quot;conv-id&quot;, () =&gt; ...)</code> or{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">observe(fn, {`{ sessionId: "conv-id" }`})</code>
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {threads.map((thread) => {
              const open = expanded[thread.sessionId] ?? false
              return (
                <ThreadCard
                  key={thread.sessionId}
                  thread={thread}
                  open={open}
                  onToggle={() => setExpanded((current) => ({ ...current, [thread.sessionId]: !current[thread.sessionId] }))}
                  onSelect={setSelected}
                />
              )
            })}
          </div>
        )}
      </div>

      <DetailDrawer trace={selected} allTraces={filteredTraces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
