'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'
import { DashboardSkeleton } from '@/components/dashboard-skeleton'
import { TimeRangeDropdown, useTimeRange } from '@/components/swarm/TimeRangeDropdown'
import { fetchSwarmAgents } from '@/lib/swarm-api'
import type { Agent } from '@/lib/trace-types'
import { formatRelativeTime } from '@/lib/api'
import { TruncationBanner } from '@/components/truncation-banner'
import { Activity, Clock, CheckCircle2, XCircle, Pause, RefreshCw, Search, Users } from 'lucide-react'
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'

function StatusBadge({ status }: { status: Agent['status'] }) {
  if (status === 'RUNNING') return (
    <span className="flex items-center gap-1.5 rounded-full border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 swarm-pulse" />RUNNING
    </span>
  )
  if (status === 'ERROR') return (
    <span className="flex items-center gap-1.5 rounded-full border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-2 py-0.5 text-[11px] font-bold text-red-700 dark:text-red-400">
      <XCircle className="w-2.5 h-2.5" />ERROR
    </span>
  )
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
      <Pause className="w-2.5 h-2.5" />IDLE
    </span>
  )
}

function AgentCard({ agent, delayMs = 0 }: { agent: Agent; delayMs?: number }) {
  const isRunning = agent.status === 'RUNNING'
  const isError = agent.status === 'ERROR'
  const lastActive = /^\d{4}-\d{2}-\d{2}T/.test(agent.lastActive) ? formatRelativeTime(agent.lastActive) : agent.lastActive

  return (
    <div className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color,box-shadow] duration-200 hover:shadow-md animate-slide-in-up ${
      isError ? 'border-red-200 dark:border-red-900/60' : 'border-border'
    }`} style={{ animationDelay: `${Math.min(delayMs, 300)}ms` }}>
      <div className={`h-1 ${isRunning ? 'bg-primary' : isError ? 'bg-red-400' : 'bg-border'}`} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-emerald-500 swarm-pulse' : isError ? 'bg-red-400' : 'bg-muted-foreground/30'}`} />
              <h3 className="text-sm font-semibold text-foreground truncate">{agent.name}</h3>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={agent.status} />
              <span className="text-[11px] text-muted-foreground">{agent.id}</span>
            </div>
          </div>
        </div>

        <div className={`rounded-lg border px-3 py-2 mb-4 ${isError ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30' : 'border-border bg-muted/30'}`}>
          <div className="text-[11px] font-medium text-muted-foreground mb-0.5">Current Task</div>
          <p className="text-xs truncate font-medium text-foreground">{agent.current_task}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { label: 'Tasks', value: String(agent.tasks), icon: Activity },
            { label: 'Success', value: agent.success_rate, icon: CheckCircle2 },
            { label: 'Uptime', value: agent.uptime, icon: Clock },
            { label: 'Tokens', value: agent.tokens, icon: RefreshCw },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center shrink-0">
                <Icon className="w-[15px] h-[15px] text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-foreground">{value}</div>
                <div className="text-[11px] text-muted-foreground">{label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border/60 bg-muted/20 px-5 py-2.5 flex justify-between items-center">
        <span className="text-[11px] text-muted-foreground">Active {lastActive}</span>
        <Link href="/traces" className="text-[11px] font-semibold text-foreground hover:text-muted-foreground transition-colors">View traces →</Link>
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState<Agent[]>([])
  const [truncated, setTruncated] = useState(false)
  const [filter, setFilter] = useState<'ALL' | 'RUNNING' | 'IDLE' | 'ERROR'>('ALL')
  const [search, setSearch] = useState('')
  const { range, setRange } = useTimeRange()

  // Refetch whenever the time range changes (Today/Week/Month/All). The
  // range is converted to a `since` timestamp client-side (in the user's
  // local TZ) and sent to /api/agents, which filters traces before grouping.
  // Default is 'today' so old agents don't clutter the view.
  useEffect(() => {
    let mounted = true
    const load = () => {
      fetchSwarmAgents(range).then((data) => {
        if (!mounted) return
        setAgents(data.agents)
        setTruncated(data.truncated)
        setLoading(false)
      })
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { mounted = false; clearInterval(id) }
  }, [range])

  if (loading) return (
    <DashboardSkeleton title="Agents" description="Registered swarm agents and their health" />
  )

  const filtered = agents
    .filter((a) => filter === 'ALL' || a.status === filter)
    .filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()) || a.id.includes(search))

  const counts = {
    RUNNING: agents.filter((a) => a.status === 'RUNNING').length,
    IDLE: agents.filter((a) => a.status === 'IDLE').length,
    ERROR: agents.filter((a) => a.status === 'ERROR').length,
  }

  return (
    <DashboardLayout>
      <PageHeader
        title="Agents"
        description="Registered swarm agents and their health"
        liveStatus={counts.RUNNING > 0 ? 'live' : agents.length > 0 ? 'paused' : 'offline'}
        actions={
          <div className="flex items-center gap-2">
            <TimeRangeDropdown value={range} onChange={setRange} />
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search agents…"
                className="h-8 rounded-lg border border-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring shadow-sm" />
            </div>
          </div>
        }
      />

      {truncated && <TruncationBanner range="the selected range" />}

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total', value: agents.length },
            { label: 'Running', value: counts.RUNNING },
            { label: 'Idle', value: counts.IDLE },
            { label: 'Error', value: counts.ERROR },
          ].map((s, idx) => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-5 shadow-sm transition-[background-color,border-color,color] duration-200 animate-slide-in-up" style={{ animationDelay: `${Math.min(idx * 40, 300)}ms` }}>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-semibold">{s.label}</div>
              <div className="text-4xl font-bold tabular-nums text-foreground leading-none tracking-tight">{s.value}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          {(['ALL', 'RUNNING', 'IDLE', 'ERROR'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                filter === f ? 'bg-primary text-primary-foreground shadow-sm' : 'border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted/60 shadow-sm'
              }`}>
              {f}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((a, idx) => <AgentCard key={a.id} agent={a} delayMs={idx * 40} />)}
        </div>

        {filtered.length === 0 && (
          <Empty className="border border-solid border-border bg-card rounded-xl py-16 shadow-sm">
            <EmptyMedia variant="icon">
              <Users className="w-5 h-5" />
            </EmptyMedia>
            {agents.length === 0 ? (
              <>
                <EmptyTitle>No agents active in this time range</EmptyTitle>
                <EmptyDescription>Try switching to &quot;This Week&quot; or &quot;All Time&quot; above.</EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>No agents match your filters</EmptyTitle>
                <EmptyDescription>Try adjusting or clearing them to see all agents.</EmptyDescription>
              </>
            )}
          </Empty>
        )}
      </div>
    </DashboardLayout>
  )
}
