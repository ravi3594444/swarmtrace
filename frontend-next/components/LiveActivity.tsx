'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// ── Types ─────────────────────────────────────────────────────────────────────
interface AgentEvent {
  id: string
  agent_id: string
  agent_name: string
  event_type: 'browser' | 'llm_token' | 'http' | 'file'
  status: 'started' | 'done' | 'error' | 'streaming' | 'info'
  data: Record<string, unknown>
  timestamp: string
}

interface Props {
  agentId: string
  agentName?: string
  maxEvents?: number
}

// ── Icons ────────────────────────────────────────────────────────────────────
const ICONS: Record<string, string> = {
  browser:   '🌐',
  llm_token: '✨',
  http:      '🔗',
  file:      '📄',
}

const STATUS_COLOR: Record<string, string> = {
  started:   'text-blue-400',
  done:      'text-green-400',
  error:     'text-red-400',
  streaming: 'text-purple-400',
  info:      'text-zinc-400',
}

function EventRow({ ev }: { ev: AgentEvent }) {
  const [expanded, setExpanded] = useState(false)
  const d = ev.data
  const hasScreenshot = typeof d.screenshot === 'string' && d.screenshot.startsWith('data:')
  const hasTokens = ev.event_type === 'llm_token' && typeof d.accumulated === 'string'

  let label = ''
  if (ev.event_type === 'browser') {
    label = `${d.method as string} ${(d.url as string || (d.args as string[])?.[0] || '').slice(0, 60)}`
  } else if (ev.event_type === 'llm_token') {
    label = `"${(d.token as string || '').slice(0, 40)}"`
  } else if (ev.event_type === 'http') {
    label = `${d.method as string} ${(d.url as string || '').slice(0, 60)} ${d.status_code ?? ''}`
  } else if (ev.event_type === 'file') {
    label = `${d.action as string} ${(d.path as string || '').split('/').slice(-2).join('/')}`
  }

  const ts = new Date(ev.timestamp).toLocaleTimeString([], { hour12: false })

  return (
    <div
      className={`group flex flex-col gap-1 px-3 py-2 rounded-lg transition-colors cursor-pointer
        ${ev.status === 'error' ? 'bg-red-500/10 hover:bg-red-500/15' : 'hover:bg-white/5'}`}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="text-base leading-none">{ICONS[ev.event_type] ?? '●'}</span>
        <span className={`text-xs font-mono ${STATUS_COLOR[ev.status]}`}>{ev.status}</span>
        <span className="text-zinc-300 flex-1 truncate font-mono">{label}</span>
        <span className="text-zinc-600 text-xs shrink-0 ml-2">{ts}</span>
        {(hasScreenshot || hasTokens) && (
          <span className="text-zinc-500 text-xs">{expanded ? '▲' : '▼'}</span>
        )}
      </div>

      {expanded && hasTokens && (
        <div className="ml-7 text-xs text-zinc-400 font-mono bg-black/20 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
          {d.accumulated as string}
        </div>
      )}

      {expanded && hasScreenshot && (
        <div className="ml-7 mt-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={d.screenshot as string}
            alt={`browser screenshot — ${d.url}`}
            className="rounded-md border border-white/10 max-w-full"
            style={{ maxHeight: 300 }}
          />
          {d.url && (
            <p className="text-zinc-500 text-xs mt-1 font-mono truncate">{d.url as string}</p>
          )}
        </div>
      )}

      {expanded && ev.status === 'error' && d.error && (
        <div className="ml-7 text-xs text-red-400 font-mono bg-red-500/10 rounded p-2">
          {d.error as string}
        </div>
      )}
    </div>
  )
}

// ── Supabase realtime client (browser-safe — uses anon key) ──────────────────
function getSupabaseClient() {
  const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return null
  return createClient(url, anon)
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function LiveActivity({ agentId, agentName, maxEvents = 200 }: Props) {
  const [events, setEvents]       = useState<AgentEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [filter, setFilter]       = useState<string>('all')
  const bottomRef = useRef<HTMLDivElement>(null)
  const autoScroll = useRef(true)

  useEffect(() => {
    const sb = getSupabaseClient()
    if (!sb) return

    // Load last 50 historical events on mount
    sb.from('agent_events')
      .select('*')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        if (data) setEvents((data as AgentEvent[]).reverse())
      })

    // Subscribe to realtime
    const channel = sb
      .channel(`fov:${agentId}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'agent_events',
          filter: `agent_id=eq.${agentId}`,
        },
        (payload) => {
          const ev = payload.new as AgentEvent
          setEvents(prev => {
            const next = [...prev, ev]
            return next.length > maxEvents ? next.slice(-maxEvents) : next
          })
        }
      )
      .subscribe(status => setConnected(status === 'SUBSCRIBED'))

    return () => { sb.removeChannel(channel) }
  }, [agentId, maxEvents])

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events])

  const filtered = filter === 'all'
    ? events
    : events.filter(e => e.event_type === filter)

  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full bg-black/20 rounded-xl border border-white/10 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`}
          />
          <span className="text-sm font-medium text-zinc-200">
            {agentName ?? agentId}
          </span>
          <span className="text-xs text-zinc-500">
            {connected ? 'live' : 'connecting…'}
          </span>
        </div>
        <span className="text-xs text-zinc-500">{events.length} events</span>
      </div>

      {/* Filter bar */}
      <div className="flex gap-1 px-3 py-2 border-b border-white/5 shrink-0 overflow-x-auto">
        {['all', 'browser', 'llm_token', 'http', 'file'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap transition-colors
              ${filter === f
                ? 'bg-white/15 text-white'
                : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {f === 'all' ? `all (${events.length})` : `${ICONS[f]} ${f} (${counts[f] ?? 0})`}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div
        className="flex-1 overflow-y-auto py-1"
        onScroll={e => {
          const el = e.currentTarget
          autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 50
        }}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            {connected ? 'Waiting for agent activity…' : 'Connecting to Supabase Realtime…'}
          </div>
        ) : (
          filtered.map(ev => <EventRow key={ev.id} ev={ev} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
