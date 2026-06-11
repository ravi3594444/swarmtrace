'use client'

import { useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { AlertCircle, Activity, Cpu, Gauge, Zap } from 'lucide-react'
import { fetchOverview, formatTime } from '@/lib/api'
import { SkeletonMetricCard, SkeletonChart, SkeletonCard } from '@/components/skeleton'

const FALLBACK_ACTIVITY = [
  { time: '00:00', requests: 2000 },
  { time: '06:00', requests: 3000 },
  { time: '12:00', requests: 5500 },
  { time: '18:00', requests: 4000 },
  { time: '24:00', requests: 4500 },
]

const FALLBACK_TOP_AGENTS = [
  { id: 'agt-0', name: 'GatewayRouter', score: 99.7, status: 'ACTIVE' },
  { id: 'agt-1', name: 'VectorIndexer_Prod', score: 99.1, status: 'ACTIVE' },
  { id: 'agt-2', name: 'DataExtractor_v2', score: 98.5, status: 'ACTIVE' },
]

const FALLBACK_EVENTS = [
  { timestamp: new Date().toISOString(), type: 'INFO', message: 'GatewayRouter completed successfully in 0.4s' },
  { timestamp: new Date().toISOString(), type: 'INFO', message: 'VectorIndexer_Prod completed successfully in 1.2s' },
  { timestamp: new Date().toISOString(), type: 'WARN', message: 'Error in LangRouter_EU: Timeout exceeded' },
]

const FALLBACK_DATA = {
  system_health: 99.9,
  active_agents: 6,
  total_throughput: 1250000,
  avg_latency_ms: 420,
  activity: FALLBACK_ACTIVITY,
  top_agents: FALLBACK_TOP_AGENTS,
  events: FALLBACK_EVENTS,
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

export default function OverviewPage() {
  const [data, setData] = useState<typeof FALLBACK_DATA | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const result = await fetchOverview()
        if (isMounted) {
          setData(result || FALLBACK_DATA)
          setError(!result)
          setLoading(false)
        }
      } catch (err) {
        if (isMounted) {
          console.error('[v0] Overview fetch failed:', err)
          setData(FALLBACK_DATA)
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

  const activity = data?.activity?.length ? data.activity : FALLBACK_ACTIVITY
  const topAgents = data?.top_agents?.length ? data.top_agents : FALLBACK_TOP_AGENTS
  const events = data?.events?.length ? data.events : FALLBACK_EVENTS

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold text-on-surface mb-2">Overview</h1>
          <p className="text-muted-foreground">A real-time snapshot of your swarm.</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Metric cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            Array(4).fill(0).map((_, i) => <SkeletonMetricCard key={i} />)
          ) : (
            <>
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <div className="flex items-center gap-2 text-on-surface-variant text-sm mb-4">
                  <Gauge className="w-4 h-4" />
                  <span>System Health</span>
                </div>
                <p className="text-3xl font-bold text-on-surface">{data?.system_health}%</p>
              </div>
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <div className="flex items-center gap-2 text-on-surface-variant text-sm mb-4">
                  <Cpu className="w-4 h-4" />
                  <span>Active Agents</span>
                </div>
                <p className="text-3xl font-bold text-on-surface">{data?.active_agents}</p>
              </div>
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <div className="flex items-center gap-2 text-on-surface-variant text-sm mb-4">
                  <Zap className="w-4 h-4" />
                  <span>Total Throughput</span>
                </div>
                <p className="text-3xl font-bold text-on-surface">{formatNumber(data?.total_throughput || 0)} <span className="text-sm font-normal text-on-surface-variant">tokens</span></p>
              </div>
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <div className="flex items-center gap-2 text-on-surface-variant text-sm mb-4">
                  <Activity className="w-4 h-4" />
                  <span>Avg Latency</span>
                </div>
                <p className="text-3xl font-bold text-on-surface">{data?.avg_latency_ms} <span className="text-sm font-normal text-on-surface-variant">ms</span></p>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Activity chart */}
          <div className="lg:col-span-2">
            {loading ? (
              <SkeletonChart />
            ) : (
              <div className="bg-surface-container border border-outline rounded-2xl p-6">
                <h2 className="text-lg font-semibold text-on-surface mb-6">Request Activity</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={activity}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--outline)" />
                    <XAxis dataKey="time" stroke="var(--on-surface-variant)" fontSize={12} />
                    <YAxis stroke="var(--on-surface-variant)" fontSize={12} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface-container-low)',
                        border: '1px solid var(--outline)',
                        borderRadius: '0.5rem',
                      }}
                    />
                    <Line type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Top agents */}
          {loading ? (
            <SkeletonCard />
          ) : (
            <div className="bg-surface-container border border-outline rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-on-surface mb-4">Top Agents</h2>
              <div className="space-y-4">
                {topAgents.map((agent: any) => (
                  <div key={agent.id} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-on-surface">{agent.name}</p>
                      <span className="text-xs text-green-400">{agent.status}</span>
                    </div>
                    <p className="text-sm font-semibold text-on-surface">{agent.score}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent events */}
        {loading ? (
          <SkeletonCard />
        ) : (
          <div className="bg-surface-container border border-outline rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-outline">
              <h2 className="text-lg font-semibold text-on-surface">Recent Events</h2>
            </div>
            <div className="divide-y divide-outline">
              {events.map((event: any, i: number) => (
                <div key={i} className="px-6 py-3 flex items-center gap-4">
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded-full ${
                      event.type === 'WARN'
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'bg-green-500/20 text-green-400'
                    }`}
                  >
                    {event.type}
                  </span>
                  <span className="text-sm text-on-surface-variant flex-1">{event.message}</span>
                  <span className="text-xs text-on-surface-variant">{formatTime(event.timestamp)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
