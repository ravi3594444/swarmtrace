'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { useSwarmTraces } from '@/lib/use-swarm-traces'
import { StatBar } from '@/components/swarm/StatBar'
import { CallTree } from '@/components/swarm/CallTree'
import { TokenChart } from '@/components/swarm/TokenChart'
import { DetailDrawer } from '@/components/swarm/DetailDrawer'
import { SwarmLoadingScreen } from '@/components/swarm/LoadingScreen'
import type { Trace } from '@/lib/trace-types'
import { fetchOverview } from '@/lib/api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Activity, Info, ChevronDown } from 'lucide-react'

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

export default function OverviewPage() {
  const { traces, loading, isLive } = useSwarmTraces(10000)
  const [selected, setSelected] = useState<Trace | null>(null)
  const [activity, setActivity] = useState<{ time: string; requests: number }[]>([])
  const [events, setEvents] = useState<OverviewEvent[]>([])

  useEffect(() => {
    let mounted = true
    fetchOverview().then((d) => {
      if (!mounted || !d) return
      if (d.activity?.length) setActivity(d.activity)
      if (d.events?.length) setEvents(d.events)
    })
    return () => { mounted = false }
  }, [])

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
          <div className="xl:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-muted-foreground" /><h3 className="text-sm font-semibold text-foreground">Request Activity</h3></div>
              <span className="text-[11px] text-muted-foreground">last 24h</span>
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
                    <XAxis dataKey="time" tick={{ fill: 'var(--muted-foreground)', fontSize: 11, fontWeight: 500 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11, fontWeight: 500 }} axisLine={false} tickLine={false} width={32} />
                    <Tooltip {...chartTooltip} />
                    <Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#colorReq)" dot={false} activeDot={{ r: 4, fill: 'var(--primary)', stroke: 'var(--card)', strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2"><Info className="w-4 h-4 text-muted-foreground" /><h3 className="text-sm font-semibold text-foreground">Live Events</h3></div>
              <span className="text-[11px] text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 swarm-pulse" />LIVE</span>
            </div>
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
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CallTree traces={traces} onSelect={setSelected} />
          <TokenChart traces={traces} />
        </div>
      </div>

      <DetailDrawer trace={selected} allTraces={traces} onClose={() => setSelected(null)} onJump={setSelected} />
    </DashboardLayout>
  )
}
