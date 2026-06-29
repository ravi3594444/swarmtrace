'use client'

import { useState, useEffect, useMemo } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { StatBar } from '@/components/swarm/StatBar'
import { CallTree } from '@/components/swarm/CallTree'
import { TokenChart } from '@/components/swarm/TokenChart'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { SwarmLoadingScreen } from '@/components/swarm/LoadingScreen'
import LiveActivity from '@/components/LiveActivity'
import type { Trace } from '@/lib/trace-types'
import { fetchOverview } from '@/lib/api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Activity, ChevronDown, ChevronUp, Info, Coins, TrendingDown } from 'lucide-react'
import { useIntegrations } from '@/contexts/IntegrationsContext'

const chartTooltip = {
  contentStyle: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.08)' },
  labelStyle: { color: 'var(--foreground)', fontWeight: 600 },
  itemStyle: { color: 'var(--foreground)' },
  cursor: { stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '4 4' },
}

type OverviewEvent = { timestamp: string; type: string; message: string }

function EventRow({ type, message }: { type: string; message: string }) {
  const [expanded, setExpanded] = useState(false)
  const isDense = message.length > 64
  const isAlert = type === 'ERROR' || type === 'WARN'

  return (
    <button
      onClick={() => isDense && setExpanded((v) => !v)}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 ${isDense ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase mt-0.5 ${isAlert ? 'bg-red-50 text-destructive border-red-200' : 'bg-muted text-muted-foreground border-border'}`}>
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

// ── Integration Panels ────────────────────────────────────────────────────────

function TokenBudgetPanel({ traces }: { traces: Trace[] }) {
  const agentTokens = useMemo(() => {
    const map = new Map<string, { name: string; input: number; output: number; calls: number }>()
    for (const t of traces) {
      const key = t.agent_id || t.agent_name || ''
      if (!key) continue
      const e = map.get(key) || { name: t.agent_name || key, input: 0, output: 0, calls: 0 }
      e.input += t.input_tokens; e.output += t.output_tokens; e.calls++
      map.set(key, e)
    }
    return Array.from(map.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output))
  }, [traces])

  const maxTotal = agentTokens[0] ? agentTokens[0].input + agentTokens[0].output : 1

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <Coins className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Token Budget Monitor</h3>
        <span className="ml-1.5 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 border border-green-500/20">
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
                <div key={a.name}>
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
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <TrendingDown className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Regression Monitor</h3>
        <span className={`ml-1.5 flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${riskFns.length > 0 ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' : 'bg-green-500/10 text-green-600 border-green-500/20'}`}>
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
                <span className="text-xs font-semibold text-yellow-600 ml-3 shrink-0">CV {(r.cv * 100).toFixed(0)}%</span>
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
  const [selected, setSelected] = useState<Trace | null>(null)
  const [activity, setActivity] = useState<{ time: string; requests: number }[]>([])
  const [events, setEvents] = useState<OverviewEvent[]>([])

  useEffect(() => {
    let mounted = true
    const load = () => {
      fetchOverview().then((d) => {
        if (!mounted || !d) return
        if (d.activity?.length) setActivity(d.activity)
        if (d.events?.length) setEvents(d.events)
      })
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // Derive unique agents from traces that have agent_id
  const activeAgents = useMemo(() => {
    const seen = new Map<string, string>()
    traces.forEach((t) => {
      if (t.agent_id && !seen.has(t.agent_id)) {
        seen.set(t.agent_id, t.agent_name ?? t.agent_id)
      }
    })
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  }, [traces])

  const [pickedAgent, setPickedAgent] = useState<string>('')

  // Auto-select the most recently active agent
  useEffect(() => {
    if (activeAgents.length > 0 && !activeAgents.find((a) => a.id === pickedAgent)) {
      setPickedAgent(activeAgents[0].id)
    }
  }, [activeAgents, pickedAgent])

  const hasRealtime = activeAgents.length > 0 && !!pickedAgent

  if (loading) return (
    <DashboardLayout>
      <SwarmLoadingScreen message="Connecting to swarm…" />
    </DashboardLayout>
  )

  const errorCount = traces.filter((t) => t.error).length

  return (
    <DashboardLayout>
      <PageHeader
        title="Overview"
        description="Live swarm health and execution summary"
        liveStatus={isLive ? 'live' : 'paused'}
        actions={
          <span className="flex items-center gap-3 text-xs font-medium text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />{traces.length - errorCount} ok</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400" />{errorCount} errors</span>
          </span>
        }
      />

      <div className="p-6 space-y-6">
        <StatBar traces={traces} />

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Activity chart — 2/3 width */}
          <div className="xl:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
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
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden flex flex-col">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 shrink-0">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">
                  {hasRealtime ? 'Live Activity' : 'Live Events'}
                </h3>
              </div>
              {hasRealtime && activeAgents.length > 1 ? (
                <AgentPicker agents={activeAgents} selected={pickedAgent} onSelect={setPickedAgent} />
              ) : (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 swarm-pulse" />LIVE
                </span>
              )}
            </div>

            {hasRealtime ? (
              <div className="flex-1 overflow-hidden min-h-0">
                <LiveActivity
                  agentId={pickedAgent}
                  agentName={activeAgents.find((a) => a.id === pickedAgent)?.name}
                />
              </div>
            ) : (
              <div className="divide-y divide-border/50 overflow-y-auto max-h-60">
                {(events.length ? events : traces.slice(0, 6).map((t) => ({
                  timestamp: t.timestamp,
                  type: t.error ? 'ERROR' : 'INFO',
                  message: t.error ? `${t.function}: ${t.error}` : `${t.function} completed in ${t.latency_sec.toFixed(2)}s`,
                }))).slice(0, 8).map((e, i) => (
                  <EventRow key={`${e.timestamp}-${i}`} type={e.type} message={e.message} />
                ))}
                {events.length === 0 && traces.length === 0 && (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">No events yet</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Integration Panels — only rendered when integrations are enabled */}
        {(isEnabled('token-budget') || isEnabled('regression-detector')) && (
          <div className={`grid grid-cols-1 gap-6 ${isEnabled('token-budget') && isEnabled('regression-detector') ? 'xl:grid-cols-2' : ''}`}>
            {isEnabled('token-budget')        && <TokenBudgetPanel traces={traces} />}
            {isEnabled('regression-detector') && <RegressionPanel  traces={traces} />}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CallTree traces={traces} onSelect={setSelected} />
          <TokenChart traces={traces} />
        </div>
      </div>

      <DetailDrawer trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
