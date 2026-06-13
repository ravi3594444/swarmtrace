'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { DashboardLayout } from '@/components/dashboard-layout'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Download, FileText, AlertCircle, Wifi, WifiOff } from 'lucide-react'
import { fetchMetrics } from '@/lib/api'
import { SkeletonChart } from '@/components/skeleton'

// ── Supabase Realtime client (anon key — read-only) ──────────────────────────
const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL  || ''
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtCost(c: number): string {
  if (c === 0)    return '$0.00'
  if (c < 0.0001) return `$${c.toFixed(8)}`
  if (c < 0.01)  return `$${c.toFixed(6)}`
  if (c < 1)     return `$${c.toFixed(4)}`
  return `$${c.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)    return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDate(d: string): string {
  // "YYYY-MM-DD" → "Jun 10"
  const [, m, day] = d.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[+m - 1]} ${+day}`
}

type MetricsData = {
  today:       { cost: number; tokens_in: number; tokens_out: number; traces: number }
  last_7_days: { cost: number; tokens_in: number; tokens_out: number; traces: number }
  this_month:  { cost: number; tokens_in: number; tokens_out: number; traces: number }
  all_time:    { cost: number; tokens_in: number; tokens_out: number; traces: number }
  chart: { date: string; cost: number; input: number; output: number; traces: number }[]
}

const EMPTY: MetricsData = {
  today:       { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
  last_7_days: { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
  this_month:  { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
  all_time:    { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 },
  chart: [],
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MetricsPage() {
  const [data,       setData]       = useState<MetricsData>(EMPTY)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(false)
  const [realtimeOk, setRealtimeOk] = useState(false)

  const supaRef    = useRef<ReturnType<typeof createClient> | null>(null)
  const channelRef = useRef<any>(null)
  const mountedRef = useRef(true)

  // ── Fetch (called on mount and on tab-visible restore) ─────────────────────
  async function load() {
    try {
      const result = await fetchMetrics()
      if (!mountedRef.current) return
      if (result) {
        setData(result)
        setError(false)
      } else {
        setError(true)
      }
    } catch {
      if (mountedRef.current) setError(true)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  // ── Realtime: subscribe when tab is visible ────────────────────────────────
  function subscribe() {
    if (!supabaseUrl || !supabaseAnon) return
    if (channelRef.current) return                          // already open

    const sb = supaRef.current ?? createClient(supabaseUrl, supabaseAnon)
    supaRef.current = sb

    channelRef.current = sb
      .channel('metrics-daily')
      .on(
        'postgres_changes',
        // Listen to both INSERT (new day) and UPDATE (row incremented by ingest)
        { event: '*', schema: 'public', table: 'daily_metrics' },
        () => { if (mountedRef.current) load() }
      )
      .subscribe((status: string) => {
        if (mountedRef.current) setRealtimeOk(status === 'SUBSCRIBED')
      })
  }

  // ── Realtime: disconnect when tab is hidden (saves Vercel invocations) ─────
  function unsubscribe() {
    if (channelRef.current && supaRef.current) {
      supaRef.current.removeChannel(channelRef.current)
      channelRef.current = null
    }
    if (mountedRef.current) setRealtimeOk(false)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true

    // Always fetch fresh data on mount
    load()

    // Subscribe to Realtime only if tab is already visible
    if (document.visibilityState === 'visible') subscribe()

    // Page Visibility API: connect/disconnect Realtime based on tab focus
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        load()        // stale while away → fetch fresh immediately
        subscribe()   // re-open Realtime socket
      } else {
        unsubscribe() // tab hidden → drop socket, no wasted connections
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', handleVisibility)
      unsubscribe()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived chart data ─────────────────────────────────────────────────────
  const chartData = data.chart.map(r => ({
    day:    fmtDate(r.date),
    input:  r.input,
    output: r.output,
    cost:   r.cost,
    traces: r.traces,
  }))

  const hasChart = chartData.length > 0

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="p-6 space-y-8">

        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-4xl font-bold text-on-surface mb-2">Metrics</h1>
            <p className="text-muted-foreground">Token consumption and cost — live when you&apos;re here.</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Live indicator */}
            <div className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border
              ${realtimeOk
                ? 'border-green-500/40 text-green-400 bg-green-500/10'
                : 'border-outline text-on-surface-variant bg-surface-container'}`}>
              {realtimeOk
                ? <><Wifi className="w-3 h-3" /><span>Live</span></>
                : <><WifiOff className="w-3 h-3" /><span>Connecting…</span></>}
            </div>
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
            <span>Could not reach API — data may be stale</span>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-3 gap-6">

          {/* Today */}
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-1">Today&apos;s Cost</h3>
            <div className="text-4xl font-bold text-primary mb-2">
              {loading ? '—' : fmtCost(data.today.cost)}
            </div>
            <p className="text-sm text-on-surface-variant">
              {loading ? '…' : `${data.today.traces.toLocaleString()} traces · ${fmtTokens(data.today.tokens_in + data.today.tokens_out)} tokens`}
            </p>
          </div>

          {/* This month */}
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-1">This Month</h3>
            <div className="text-4xl font-bold text-primary mb-2">
              {loading ? '—' : fmtCost(data.this_month.cost)}
            </div>
            <p className="text-sm text-on-surface-variant">
              {loading ? '…' : `${data.this_month.traces.toLocaleString()} traces · ${fmtTokens(data.this_month.tokens_in + data.this_month.tokens_out)} tokens`}
            </p>
          </div>

          {/* All time */}
          <div className="bg-surface-container border border-outline rounded-2xl p-6">
            <h3 className="text-sm text-on-surface-variant mb-1">All Time</h3>
            <div className="text-4xl font-bold text-primary mb-2">
              {loading ? '—' : data.all_time.traces.toLocaleString()}
              {!loading && <span className="text-xl font-normal text-on-surface-variant ml-1">runs</span>}
            </div>
            <p className="text-sm text-on-surface-variant">
              {loading ? '…' : `${fmtCost(data.all_time.cost)} total · ${fmtTokens(data.all_time.tokens_in + data.all_time.tokens_out)} tokens`}
            </p>
          </div>
        </div>

        {/* Token Consumption Chart */}
        <div className="bg-surface-container border border-outline rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-1">Token Consumption</h2>
          <p className="text-sm text-on-surface-variant mb-6">Input vs output tokens per day</p>

          {loading ? <SkeletonChart /> : !hasChart ? (
            <div className="h-[300px] flex items-center justify-center text-on-surface-variant text-sm">
              No trace data yet — start ingesting to see this chart.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
                <XAxis dataKey="day" stroke="#8e9192" tick={{ fontSize: 11 }} />
                <YAxis stroke="#8e9192" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtTokens(v)} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#121212', border: '1px solid #333333', color: '#e5e2e1', borderRadius: 8 }}
                  formatter={(v, name) => [fmtTokens(Number(v)), name === 'input' ? 'Input tokens' : 'Output tokens']}
                />
                <Bar dataKey="input"  stackId="a" fill="#ffffff" name="input" />
                <Bar dataKey="output" stackId="a" fill="#c8c6c6" name="output" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Cost Over Time Chart */}
        <div className="bg-surface-container border border-outline rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-1">Cost Over Time</h2>
          <p className="text-sm text-on-surface-variant mb-6">Daily spend in USD</p>

          {loading ? <SkeletonChart /> : !hasChart ? (
            <div className="h-[300px] flex items-center justify-center text-on-surface-variant text-sm">
              No cost data yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333333" />
                <XAxis dataKey="day" stroke="#8e9192" tick={{ fontSize: 11 }} />
                <YAxis stroke="#8e9192" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtCost(v)} width={72} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#121212', border: '1px solid #333333', color: '#e5e2e1', borderRadius: 8 }}
                  formatter={(v) => [fmtCost(Number(v)), 'Cost']}
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="#ffffff"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#ffffff' }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

      </div>
    </DashboardLayout>
  )
}
