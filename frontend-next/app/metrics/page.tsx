'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { Download, FileText, AlertCircle, Wifi, WifiOff, Loader2 } from 'lucide-react'
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

// ── Export helpers ────────────────────────────────────────────────────────────
function exportCSV(data: MetricsData) {
  const rows = [
    ['Date', 'Cost (USD)', 'Input Tokens', 'Output Tokens', 'Traces'],
    ...data.chart.map(r => [r.date, r.cost.toFixed(6), r.input, r.output, r.traces]),
    [],
    ['Period', 'Cost (USD)', 'Input Tokens', 'Output Tokens', 'Traces'],
    ['Today',      data.today.cost.toFixed(6),      data.today.tokens_in,      data.today.tokens_out,      data.today.traces],
    ['Last 7 Days',data.last_7_days.cost.toFixed(6), data.last_7_days.tokens_in, data.last_7_days.tokens_out, data.last_7_days.traces],
    ['This Month', data.this_month.cost.toFixed(6),  data.this_month.tokens_in,  data.this_month.tokens_out,  data.this_month.traces],
    ['All Time',   data.all_time.cost.toFixed(6),    data.all_time.tokens_in,    data.all_time.tokens_out,    data.all_time.traces],
  ]
  const csv = rows.map(r => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `swarmtrace-metrics-${new Date().toISOString().slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

async function exportPDF(data: MetricsData) {
  // Build a self-contained HTML report and print-to-PDF via browser
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const rows = data.chart.map(r =>
    `<tr><td>${r.date}</td><td>${fmtCost(r.cost)}</td><td>${fmtTokens(r.input)}</td><td>${fmtTokens(r.output)}</td><td>${r.traces}</td></tr>`
  ).join('')

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <title>SwarmTrace Metrics Report</title>
  <style>
    body{font-family:system-ui,sans-serif;padding:40px;color:#111;max-width:900px;margin:0 auto}
    h1{font-size:28px;margin-bottom:4px}
    .subtitle{color:#666;margin-bottom:32px}
    .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
    .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px}
    .card-label{font-size:12px;color:#666;margin-bottom:4px}
    .card-value{font-size:22px;font-weight:700;color:#111}
    .card-sub{font-size:11px;color:#888;margin-top:4px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{text-align:left;padding:8px 12px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-weight:600}
    td{padding:8px 12px;border-bottom:1px solid #f3f4f6}
    tr:last-child td{border-bottom:none}
    h2{font-size:16px;margin:24px 0 12px}
    .footer{margin-top:32px;font-size:11px;color:#aaa;text-align:center}
  </style></head><body>
  <h1>SwarmTrace Metrics Report</h1>
  <div class="subtitle">Generated ${date}</div>
  <div class="cards">
    <div class="card"><div class="card-label">Today</div><div class="card-value">${fmtCost(data.today.cost)}</div><div class="card-sub">${data.today.traces} traces · ${fmtTokens(data.today.tokens_in+data.today.tokens_out)} tokens</div></div>
    <div class="card"><div class="card-label">Last 7 Days</div><div class="card-value">${fmtCost(data.last_7_days.cost)}</div><div class="card-sub">${data.last_7_days.traces} traces · ${fmtTokens(data.last_7_days.tokens_in+data.last_7_days.tokens_out)} tokens</div></div>
    <div class="card"><div class="card-label">This Month</div><div class="card-value">${fmtCost(data.this_month.cost)}</div><div class="card-sub">${data.this_month.traces} traces · ${fmtTokens(data.this_month.tokens_in+data.this_month.tokens_out)} tokens</div></div>
    <div class="card"><div class="card-label">All Time</div><div class="card-value">${data.all_time.traces.toLocaleString()}</div><div class="card-sub">${fmtCost(data.all_time.cost)} total</div></div>
  </div>
  <h2>Daily Breakdown (last ${data.chart.length} days)</h2>
  <table><thead><tr><th>Date</th><th>Cost</th><th>Input Tokens</th><th>Output Tokens</th><th>Traces</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <div class="footer">SwarmTrace · swarmtrace.vercel.app</div>
  </body></html>`

  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
  win.onload = () => { win.print() }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function MetricsPage() {
  const [data,       setData]       = useState<MetricsData>(EMPTY)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(false)
  const [realtimeOk, setRealtimeOk] = useState(false)
  const [exporting,  setExporting]  = useState<'csv'|'pdf'|null>(null)

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
      <PageHeader
        title="Metrics"
        description="Token consumption and cost analytics"
        status={{ label: realtimeOk ? 'Live' : 'Connecting…', variant: realtimeOk ? 'active' : 'idle' }}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setExporting('csv'); exportCSV(data); setTimeout(() => setExporting(null), 1000) }}
              disabled={loading || exporting !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
              {exporting === 'csv' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              CSV
            </button>
            <button
              onClick={async () => { setExporting('pdf'); await exportPDF(data); setTimeout(() => setExporting(null), 1000) }}
              disabled={loading || exporting !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40">
              {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
              PDF
            </button>
          </div>
        }
      />
      <div className="p-5 space-y-5">

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
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
                <CartesianGrid strokeDasharray="3 3" stroke="var(--outline)" />
                <XAxis dataKey="day" stroke="var(--on-surface-variant)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--on-surface-variant)" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtTokens(v)} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--surface-container-low)', border: '1px solid var(--outline)', color: 'var(--on-surface)', borderRadius: 8 }}
                  formatter={(v, name) => [fmtTokens(Number(v)), name === 'input' ? 'Input tokens' : 'Output tokens']}
                />
                <Bar dataKey="input"  stackId="a" fill="var(--chart-1)" name="input" />
                <Bar dataKey="output" stackId="a" fill="var(--chart-2)" name="output" radius={[3, 3, 0, 0]} />
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
                <CartesianGrid strokeDasharray="3 3" stroke="var(--outline)" />
                <XAxis dataKey="day" stroke="var(--on-surface-variant)" tick={{ fontSize: 11 }} />
                <YAxis stroke="var(--on-surface-variant)" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtCost(v)} width={72} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'var(--surface-container-low)', border: '1px solid var(--outline)', color: 'var(--on-surface)', borderRadius: 8 }}
                  formatter={(v) => [fmtCost(Number(v)), 'Cost']}
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'var(--primary)' }}
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
