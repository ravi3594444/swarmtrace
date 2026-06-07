'use client'

import { memo, useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { TrendingUp, Activity, Clock, Database, Download, Calendar, AlertCircle } from 'lucide-react'
import { fetchOverview, formatTime } from '@/lib/api'
import { SkeletonMetricCard, SkeletonChart } from '@/components/skeleton'

const FALLBACK_ACTIVITY = [
  { time: '00:00', requests: 2000 },
  { time: '06:00', requests: 3000 },
  { time: '12:00', requests: 5500 },
  { time: '18:00', requests: 4000 },
  { time: '24:00', requests: 4500 },
]

const FALLBACK_AGENTS = [
  { id: 'ext-8829', name: 'DataExtractor_v2', score: 98.5, status: 'ACTIVE' },
  { id: 'agt-1024', name: 'CodeAnalyzer_Beta', score: 96.2, status: 'ACTIVE' },
  { id: 'rtr-5021', name: 'LangRouter_EU', score: 94.8, status: 'IDLE' },
]

const FALLBACK_EVENTS = [
  { timestamp: '2024-01-15T14:32:01Z', type: 'INFO', message: 'Auto-scaling initiated. Deploying +5 instances of DataExtractor_v2 to handle queue spike.' },
  { timestamp: '2024-01-15T14:28:45Z', type: 'WARN', message: 'Latency threshold exceeded on VectorIndexer_Prod (Avg: 450ms). Monitoring...' },
  { timestamp: '2024-01-15T14:15:00Z', type: 'INFO', message: 'Scheduled model weights update completed for CodeAnalyzer_Beta.' },
]

const MetricCard = memo(({ label, value, icon: Icon, trend, trendValue }: any) => (
  <div className="bg-surface-container border border-outline rounded-2xl p-6 animate-in fade-in duration-300">
    <div className="flex justify-between items-start mb-4">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <Icon className="w-5 h-5 text-outline-variant" />
    </div>
    <div className="text-4xl font-bold text-primary mb-2">{value}</div>
    <div className="flex items-center gap-1">
      <TrendingUp className="w-4 h-4 text-primary" />
      <span className="text-sm text-on-surface-variant">{trendValue}</span>
    </div>
  </div>
))
MetricCard.displayName = 'MetricCard'

const AgentCard = memo(({ agent }: any) => (
  <div key={agent.id} className="border-b border-outline pb-4 last:border-b-0 animate-in fade-in duration-300">
    <div className="flex items-start justify-between mb-2">
      <div>
        <p className="font-semibold text-on-surface">{agent.name}</p>
        <p className="text-xs text-on-surface-variant">ID: {agent.id}</p>
      </div>
      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${agent.status === 'ACTIVE' ? 'bg-green-500/20 text-green-400' : 'bg-outline-variant text-on-surface-variant'}`}>
        {agent.status}
      </span>
    </div>
    <p className="text-lg font-bold text-primary">{agent.score}%</p>
    <p className="text-xs text-on-surface-variant">Score</p>
  </div>
))
AgentCard.displayName = 'AgentCard'

const EventItem = memo(({ event, idx }: any) => (
  <div key={idx} className="border-b border-outline pb-4 last:border-b-0 animate-in fade-in duration-300" style={{ animationDelay: `${idx * 50}ms` }}>
    <div className="flex gap-4">
      <div className="flex-shrink-0">
        <div className={`px-3 py-1 rounded font-mono text-xs font-bold ${event.type === 'INFO' ? 'bg-blue-500/20 text-blue-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
          {event.type}
        </div>
      </div>
      <div className="flex-1">
        <p className="text-sm text-on-surface">{event.message}</p>
        <p className="text-xs text-on-surface-variant mt-1">{event.timestamp || event.time}</p>
      </div>
    </div>
  </div>
))
EventItem.displayName = 'EventItem'

const MetricCardLoading = () => <SkeletonMetricCard />

export default function OverviewPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const result = await fetchOverview()
        if (isMounted) {
          if (result) {
            setData(result)
          } else {
            setData({
              metrics: [
                { label: 'System Health', value: '99.9%', icon: 'Activity', trend: '↑ 0.1% from yesterday' },
                { label: 'Active Agents', value: '142', icon: 'Database', trend: '↑ 12 new deployments' },
                { label: 'Total Throughput', value: '8,450', icon: 'Activity', trend: 'req/s average' },
                { label: 'Avg Latency', value: '12ms', icon: 'Clock', trend: '↓ 2ms improvement' },
              ],
              activity: FALLBACK_ACTIVITY,
              top_agents: FALLBACK_AGENTS,
              events: FALLBACK_EVENTS,
            })
            setError(true)
          }
          setLoading(false)
        }
      } catch (err) {
        if (isMounted) {
          console.error('[v0] Overview fetch failed:', err)
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

  const activity = data?.activity || FALLBACK_ACTIVITY
  const topAgents = data?.top_agents || FALLBACK_AGENTS
  const events = data?.events || FALLBACK_EVENTS

  return (
    <DashboardLayout>
      <div className="p-6 space-y-8">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Overview</h1>
            <p className="text-muted-foreground">System performance and agent activity.</p>
          </div>
          <div className="flex gap-3">
            <button className="flex items-center gap-2 px-4 py-2 rounded-full border border-border text-on-surface-variant hover:border-outline transition-colors text-sm font-medium">
              <Calendar className="w-4 h-4" />
              <span>Last 24 Hours</span>
            </button>
            <button
              onClick={() => {
                const blob = new Blob([JSON.stringify(data || { activity, topAgents, events }, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `overview-${new Date().toISOString().split('T')[0]}.json`
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity text-sm"
            >
              <Download className="w-4 h-4" />
              <span>Export Report</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Metrics Grid */}
        <div className="grid grid-cols-4 gap-4">
          {loading ? (
            <>
              <MetricCardLoading />
              <MetricCardLoading />
              <MetricCardLoading />
              <MetricCardLoading />
            </>
          ) : (
            <>
              <MetricCard label="System Health" value="99.9%" icon={Activity} trendValue="↑ 0.1% from yesterday" />
              <MetricCard label="Active Agents" value="142" icon={Database} trendValue="↑ 12 new deployments" />
              <MetricCard label="Total Throughput" value="8,450" icon={Activity} trendValue="req/s average" />
              <MetricCard label="Avg Latency" value="12ms" icon={Clock} trendValue="↓ 2ms improvement" />
            </>
          )}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-surface-container border border-outline rounded-2xl p-6">
            <h2 className="text-xl font-semibold text-on-surface mb-6">System Activity</h2>
            <div className="flex gap-2 mb-6">
              <button className="px-3 py-1 rounded-full bg-surface-container-high text-on-surface text-xs font-medium">1H</button>
              <button className="px-3 py-1 rounded-full text-on-surface-variant text-xs font-medium hover:bg-surface-container-high">24H</button>
              <button className="px-3 py-1 rounded-full text-on-surface-variant text-xs font-medium hover:bg-surface-container-high">7D</button>
            </div>
            {loading ? <SkeletonChart /> : (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={activity}>
                <defs>
                  <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ffffff" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ffffff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
                <XAxis dataKey="time" stroke="#8e9192" />
                <YAxis stroke="#8e9192" />
                <Tooltip contentStyle={{ backgroundColor: '#121212', border: '1px solid #333333', color: '#e5e2e1' }} />
                <Area type="monotone" dataKey="value" stroke="#ffffff" fillOpacity={1} fill="url(#colorRequests)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>

          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold text-on-surface">Top Performing Agents</h2>
              <button className="text-sm text-on-surface-variant hover:text-on-surface">View All</button>
            </div>
            <div className="space-y-4">
              {topAgents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          </div>
        </div>

        {/* Events */}
        <div className="bg-surface-container border border-outline rounded-2xl p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-semibold text-on-surface">System Events</h2>
            <button className="text-sm text-on-surface-variant hover:text-on-surface">Live View</button>
          </div>
          <div className="space-y-4">
            {events.map((event, idx) => (
              <EventItem key={idx} event={event} idx={idx} />
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
