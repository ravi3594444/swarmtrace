'use client'

import { memo, useState, useEffect } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { Download, FileText, AlertCircle } from 'lucide-react'
import { fetchMetrics } from '@/lib/api'
import { SkeletonChart } from '@/components/skeleton'

const FALLBACK_TOKEN_DATA = [
  { day: '01', input: 1200, output: 800 },
  { day: '05', input: 2300, output: 1300 },
  { day: '10', input: 3100, output: 2000 },
  { day: '15', input: 2800, output: 1900 },
  { day: '20', input: 4500, output: 3200 },
  { day: '25', input: 3800, output: 2800 },
  { day: '30', input: 5200, output: 3900 },
]

const FALLBACK_LATENCY = [
  { time: '0:00', 'Retrieval_v2': 45, 'Synthesis_v1': 38, 'Router_fast': 28 },
  { time: '4:00', 'Retrieval_v2': 52, 'Synthesis_v1': 42, 'Router_fast': 31 },
  { time: '8:00', 'Retrieval_v2': 38, 'Synthesis_v1': 35, 'Router_fast': 24 },
  { time: '12:00', 'Retrieval_v2': 65, 'Synthesis_v1': 58, 'Router_fast': 42 },
  { time: '16:00', 'Retrieval_v2': 48, 'Synthesis_v1': 41, 'Router_fast': 29 },
  { time: '20:00', 'Retrieval_v2': 55, 'Synthesis_v1': 48, 'Router_fast': 35 },
]

const ChartTooltip = memo(() => (
  <div className="bg-surface-container-low border border-outline rounded p-2 shadow-lg" />
))
ChartTooltip.displayName = 'ChartTooltip'

export default function MetricsPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let isMounted = true
    const load = async () => {
      try {
        const result = await fetchMetrics()
        if (isMounted) {
          if (result) {
            setData(result)
          } else {
            setData({
              daily_burn_rate: 847.50,
              projected_monthly: 25425,
              budget: 50000,
              spent: 12563,
              token_volume: { chart: FALLBACK_TOKEN_DATA },
              latency_heatmap: FALLBACK_LATENCY,
            })
            setError(true)
          }
          setLoading(false)
        }
      } catch (err) {
        if (isMounted) {
          console.error('[v0] Metrics fetch failed:', err)
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
  const tokenData = data?.token_volume?.chart || FALLBACK_TOKEN_DATA
  const latencyData = data?.latency_heatmap || FALLBACK_LATENCY
  const burnRate = data?.daily_burn_rate || 847.50
  const projected = data?.projected_monthly || 25425
  const budget = data?.budget || 50000
  const spent = data?.spent || 12563

  return (
    <DashboardLayout>
      <div className="p-6 space-y-8">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Metrics</h1>
            <p className="text-muted-foreground">Token consumption, latency, and cost analysis.</p>
          </div>
          <div className="flex gap-3">
            <button className="flex items-center gap-2 px-4 py-2 rounded-full border border-border text-on-surface-variant hover:border-outline transition-colors text-sm font-medium">
              <Download className="w-4 h-4" />
              <span>CSV</span>
            </button>
            <button className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity text-sm">
              <FileText className="w-4 h-4" />
              <span>Export PDF</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-full bg-red-500/20 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            <span>API unavailable — showing cached data</span>
          </div>
        )}

        {/* Cost Metrics */}
        <div className="grid grid-cols-3 gap-6">
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-4">Daily Burn Rate</h3>
            <div className="text-4xl font-bold text-primary mb-2">${burnRate.toFixed(2)}</div>
            <p className="text-sm text-on-surface-variant">Avg cost over 24h</p>
          </div>
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-4">Projected Monthly</h3>
            <div className="text-4xl font-bold text-primary mb-2">${projected.toLocaleString()}</div>
            <p className="text-sm text-on-surface-variant">At current rate</p>
          </div>
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-4">Budget Progress</h3>
            <div className="mb-3">
              <div className="w-full bg-surface-container-low border border-outline rounded-full h-2 overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${(spent / budget) * 100}%` }} />
              </div>
            </div>
            <p className="text-sm text-on-surface">${spent.toLocaleString()} / ${budget.toLocaleString()}</p>
          </div>
        </div>

        {/* Token Consumption Chart */}
        <div className="bg-surface-container border border-outline rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-6">Token Consumption</h2>
          {loading ? <SkeletonChart /> : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={tokenData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
              <XAxis dataKey="day" stroke="#8e9192" />
              <YAxis stroke="#8e9192" />
              <Tooltip contentStyle={{ backgroundColor: '#121212', border: '1px solid #333333', color: '#e5e2e1' }} />
              <Bar dataKey="input" stackId="a" fill="#ffffff" />
              <Bar dataKey="output" stackId="a" fill="#c8c6c6" />
            </BarChart>
          </ResponsiveContainer>
          )}
        </div>

        {/* Latency Distribution */}
        <div className="bg-surface-container border border-outline rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-6">Latency by Agent</h2>
          {loading ? <SkeletonChart /> : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={latencyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
              <XAxis dataKey="time" stroke="#8e9192" />
              <YAxis stroke="#8e9192" />
              <Tooltip contentStyle={{ backgroundColor: '#121212', border: '1px solid #333333', color: '#e5e2e1' }} />
              <Line type="monotone" dataKey="Retrieval_v2" stroke="#ffffff" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Synthesis_v1" stroke="#c8c6c6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Router_fast" stroke="#8e9192" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
