'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { AlertCircle, Activity, Cpu, Gauge, Zap } from 'lucide-react'
import { fetchOverview, formatTime } from '@/lib/api'
import { SkeletonMetricCard, SkeletonChart, SkeletonCard } from '@/components/skeleton'
import { createClient } from '@supabase/supabase-js'

// ─── Supabase realtime client (anon key only — read-only, public) ────────────
// NEXT_PUBLIC_ vars are safe to expose in the browser
const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  || ''
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// ─── Fallback data ─────────────────────────────────────────────────────────
const FALLBACK_ACTIVITY = [
  { time: '00:00', requests: 2000 },
  { time: '06:00', requests: 3000 },
  { time: '12:00', requests: 5500 },
  { time: '18:00', requests: 4000 },
  { time: '24:00', requests: 4500 },
]
const FALLBACK_TOP_AGENTS = [
  { id: 'agt-0', name: 'GatewayRouter',       score: 99.7, status: 'ACTIVE' },
  { id: 'agt-1', name: 'VectorIndexer_Prod',  score: 99.1, status: 'ACTIVE' },
  { id: 'agt-2', name: 'DataExtractor_v2',    score: 98.5, status: 'ACTIVE' },
]
const FALLBACK_EVENTS = [
  { timestamp: new Date().toISOString(), type: 'INFO', message: 'GatewayRouter completed successfully in 0.4s' },
  { timestamp: new Date().toISOString(), type: 'INFO', message: 'VectorIndexer_Prod completed successfully in 1.2s' },
  { timestamp: new Date().toISOString(), type: 'WARN', message: 'Error in LangRouter_EU: Timeout exceeded' },
]
const FALLBACK_DATA = {
  system_health: 99.9, active_agents: 6,
  total_throughput: 1250000, avg_latency_ms: 420,
  activity: FALLBACK_ACTIVITY, top_agents: FALLBACK_TOP_AGENTS, events: FALLBACK_EVENTS,
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

// ─── Animated stat value — counts up when value changes ────────────────────
function AnimatedNumber({
  value, format = (v: number) => `${v}`, pulse = false
}: {
  value: number; format?: (v: number) => string; pulse?: boolean
}) {
  const [display, setDisplay]   = useState(value)
  const [flashing, setFlashing] = useState(false)
  const prevRef = useRef(value)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (value === prevRef.current) return
    const from  = prevRef.current
    const to    = value
    const diff  = to - from
    prevRef.current = to

    // Flash the card
    setFlashing(true)
    setTimeout(() => setFlashing(false), 800)

    // Animate count
    const start    = performance.now()
    const duration = Math.min(600, Math.abs(diff) * 2)

    const tick = (now: number) => {
      const t   = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1 - t, 3) // ease-out cubic
      setDisplay(Math.round(from + diff * ease))
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
    }
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(tick)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [value])

  return (
    <span
      className="transition-colors duration-300"
      style={{ color: flashing && pulse ? 'var(--color-primary)' : undefined }}
    >
      {format(display)}
    </span>
  )
}

// ─── Live dot — shows when Realtime is connected ────────────────────────────
function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {active && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
      )}
      <span className={`relative inline-flex rounded-full h-2 w-2 ${active ? 'bg-green-500' : 'bg-outline-variant'}`} />
    </span>
  )
}

// ─── Stat card ───────────────────────────────────────────────────────────────
function StatCard({
  icon: Icon, label, value, format, unit, pulse = false
}: {
  icon: React.ElementType; label: string; value: number
  format?: (v: number) => string; unit?: string; pulse?: boolean
}) {
  const [popped, setPopped] = useState(false)
  const prevRef = useRef(value)

  useEffect(() => {
    if (value !== prevRef.current) {
      prevRef.current = value
      setPopped(true)
      setTimeout(() => setPopped(false), 400)
    }
  }, [value])

  return (
    <div
      className={`
        relative bg-surface-container border rounded-2xl p-6 overflow-hidden
        transition-all duration-300
        ${popped ? 'border-primary/60 shadow-sm shadow-primary/20' : 'border-outline'}
      `}
    >
      {/* Pulse ring on new data */}
      {popped && (
        <span className="absolute inset-0 rounded-2xl border-2 border-primary/40 animate-ping pointer-events-none" />
      )}

      <div className="flex items-center gap-2 text-on-surface-variant text-sm mb-4">
        <Icon className={`w-4 h-4 transition-colors duration-300 ${popped ? 'text-primary' : ''}`} />
        <span>{label}</span>
      </div>

      <p className={`text-3xl font-bold transition-all duration-300 ${popped ? 'scale-105' : 'scale-100'} inline-block`}>
        <AnimatedNumber value={value} format={format} pulse={pulse} />
        {unit && <span className="text-sm font-normal text-on-surface-variant ml-1">{unit}</span>}
      </p>
    </div>
  )
}

// ─── Live event ticker row ───────────────────────────────────────────────────
function EventRow({ event, isNew }: { event: any; isNew: boolean }) {
  const [visible, setVisible] = useState(!isNew)

  useEffect(() => {
    if (isNew) {
      // Slide in
      const t = setTimeout(() => setVisible(true), 30)
      return () => clearTimeout(t)
    }
  }, [isNew])

  return (
    <div
      className={`
        px-6 py-3 flex items-center gap-4
        transition-all duration-500
        ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}
        ${isNew ? 'bg-primary/5' : ''}
      `}
    >
      <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
        event.type === 'WARN'  ? 'bg-yellow-500/20 text-yellow-500' :
        event.type === 'ERROR' ? 'bg-red-500/20 text-red-500' :
                                  'bg-green-500/20 text-green-500'
      }`}>
        {event.type}
      </span>
      <span className="text-sm text-on-surface-variant flex-1 truncate">{event.message}</span>
      <span className="text-xs text-on-surface-variant shrink-0">{formatTime(event.timestamp)}</span>
    </div>
  )
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function OverviewPage() {
  const [data,    setData]    = useState<typeof FALLBACK_DATA | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)
  const [liveEvents, setLiveEvents] = useState<any[]>([])
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set())
  const [realtimeOk,  setRealtimeOk]  = useState(false)
  // stats that update from realtime
  const [liveStats, setLiveStats] = useState({
    active_agents: 0, total_throughput: 0, avg_latency_ms: 0, trace_count: 0
  })
  const supaRef = useRef<ReturnType<typeof createClient> | null>(null)

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    fetchOverview()
      .then(result => {
        if (!mounted) return
        const d = result || FALLBACK_DATA
        setData(d)
        setError(!result)
        setLoading(false)
        setLiveStats({
          active_agents:    d.active_agents    ?? 0,
          total_throughput: d.total_throughput ?? 0,
          avg_latency_ms:   d.avg_latency_ms   ?? 0,
          trace_count:      0,
        })
        setLiveEvents((d.events || []).slice(0, 8))
      })
      .catch(() => {
        if (!mounted) return
        setData(FALLBACK_DATA)
        setError(true)
        setLoading(false)
        setLiveEvents(FALLBACK_EVENTS.slice(0, 8))
      })
    return () => { mounted = false }
  }, [])

  // ── Supabase Realtime subscription ────────────────────────────────────────
  useEffect(() => {
    if (!supabaseUrl || !supabaseAnon) return // env vars not set — gracefully skip

    const sb = createClient(supabaseUrl, supabaseAnon)
    supaRef.current = sb

    const channel = sb
      .channel('overview-traces')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'traces' },
        (payload: any) => {
          const trace = payload.new
          const id = trace.id || `rt-${Date.now()}`

          // Build event row from the incoming trace
          const newEvent = {
            id,
            timestamp: trace.timestamp || new Date().toISOString(),
            type:    trace.error ? 'ERROR' : 'INFO',
            message: trace.error
              ? `Error in ${trace.function}: ${trace.error}`
              : `${trace.function} completed in ${((trace.latency_sec || 0) * 1000).toFixed(0)}ms`,
          }

          // Prepend to feed, keep last 20
          setLiveEvents(prev => [newEvent, ...prev].slice(0, 20))
          setNewEventIds(prev => new Set([...prev, id]))
          setTimeout(() => {
            setNewEventIds(prev => { const s = new Set(prev); s.delete(id); return s })
          }, 3000)

          // Bump live stats
          setLiveStats(prev => ({
            active_agents:    prev.active_agents,
            total_throughput: prev.total_throughput + (trace.input_tokens || 0) + (trace.output_tokens || 0),
            avg_latency_ms:   prev.trace_count > 0
              ? Math.round((prev.avg_latency_ms * prev.trace_count + (trace.latency_sec || 0) * 1000) / (prev.trace_count + 1))
              : Math.round((trace.latency_sec || 0) * 1000),
            trace_count: prev.trace_count + 1,
          }))
        }
      )
      .subscribe((status: string) => {
        setRealtimeOk(status === 'SUBSCRIBED')
      })

    return () => { sb.removeChannel(channel) }
  }, [])

  const activity  = data?.activity?.length    ? data.activity   : FALLBACK_ACTIVITY
  const topAgents = data?.top_agents?.length  ? data.top_agents : FALLBACK_TOP_AGENTS

  const stats = {
    system_health:    data?.system_health    ?? 99.9,
    active_agents:    liveStats.active_agents || data?.active_agents    || 0,
    total_throughput: liveStats.total_throughput || data?.total_throughput || 0,
    avg_latency_ms:   liveStats.avg_latency_ms   || data?.avg_latency_ms   || 0,
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Overview</h1>
            <p className="text-muted-foreground">A real-time snapshot of your swarm.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-on-surface-variant mt-1">
            <LiveDot active={realtimeOk} />
            <span>{realtimeOk ? 'Live' : 'Connecting…'}</span>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            Array(4).fill(0).map((_, i) => <SkeletonMetricCard key={i} />)
          ) : (
            <>
              <StatCard
                icon={Gauge} label="System Health"
                value={stats.system_health}
                format={v => `${v.toFixed(1)}%`}
              />
              <StatCard
                icon={Cpu} label="Active Agents"
                value={stats.active_agents}
                pulse
              />
              <StatCard
                icon={Zap} label="Total Throughput"
                value={stats.total_throughput}
                format={formatNumber}
                unit="tokens"
                pulse
              />
              <StatCard
                icon={Activity} label="Avg Latency"
                value={stats.avg_latency_ms}
                unit="ms"
                pulse
              />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Activity chart */}
          <div className="lg:col-span-2">
            {loading ? <SkeletonChart /> : (
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <h2 className="text-lg font-semibold text-on-surface mb-6">Request Activity</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={activity}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--outline)" />
                    <XAxis dataKey="time" stroke="var(--on-surface-variant)" fontSize={12} />
                    <YAxis stroke="var(--on-surface-variant)" fontSize={12} />
                    <Tooltip contentStyle={{
                      backgroundColor: 'var(--surface-container-low)',
                      border: '1px solid var(--outline)',
                      borderRadius: '0.5rem',
                    }} />
                    <Line type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Top agents */}
          {loading ? <SkeletonCard /> : (
            <div className="bg-surface-container border border-outline rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-on-surface mb-4">Top Agents</h2>
              <div className="space-y-4">
                {topAgents.map((agent: any) => (
                  <div key={agent.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-on-surface">{agent.name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        <span className="text-xs text-green-500">{agent.status}</span>
                      </div>
                    </div>
                    <p className="text-sm font-semibold text-on-surface">{agent.score}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Live event feed */}
        {loading ? <SkeletonCard /> : (
          <div className="bg-surface-container border border-outline rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-outline flex items-center justify-between">
              <h2 className="text-lg font-semibold text-on-surface">Live Events</h2>
              <div className="flex items-center gap-2">
                <LiveDot active={realtimeOk} />
                <span className="text-xs text-on-surface-variant">
                  {liveStats.trace_count > 0 ? `+${liveStats.trace_count} this session` : 'Waiting for traces…'}
                </span>
              </div>
            </div>
            <div className="divide-y divide-outline">
              {liveEvents.slice(0, 10).map((event: any) => (
                <EventRow key={event.id ?? event.timestamp} event={event} isNew={newEventIds.has(event.id)} />
              ))}
              {liveEvents.length === 0 && (
                <div className="px-6 py-8 text-center text-sm text-on-surface-variant">
                  No events yet — deploy your agent with <code className="font-mono text-xs bg-surface-container-high px-1.5 py-0.5 rounded">@observe</code> to see live data here
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </DashboardLayout>
  )
}
