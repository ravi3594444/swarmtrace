'use client'

import { useRef, useState } from 'react'
import { useAgentEvents, AgentEvent, EventData } from '@/contexts/RealtimeContext'

// ── Per-event data shapes (re-exported from context for convenience) ──────────
interface BrowserData  { method?: string; url?: string; args?: string[]; screenshot?: string; error?: string }
interface LlmTokenData { token?: string; accumulated?: string }
interface HttpData     { method?: string; url?: string; status_code?: number; error?: string }
interface FileData     { action?: string; path?: string }

interface Props {
  agentId: string
  agentName?: string
  maxEvents?: number
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const ICONS: Record<string, string> = {
  browser:     '🌐',
  llm_token:   '✨',
  http:        '🔗',
  file:        '📄',
  screen_tick: '📸',
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
  const d = ev.data as EventData

  const screenshot  = (d as BrowserData).screenshot
  const accumulated = (d as LlmTokenData).accumulated
  const hasScreenshot = typeof screenshot === 'string' && screenshot.startsWith('data:')
  const hasTokens     = ev.event_type === 'llm_token' && typeof accumulated === 'string'

  let label = ''
  if (ev.event_type === 'browser') {
    const bd = d as BrowserData
    label = `${bd.method ?? ''} ${(bd.url ?? bd.args?.[0] ?? '').slice(0, 60)}`
  } else if (ev.event_type === 'llm_token') {
    label = `"${((d as LlmTokenData).token ?? '').slice(0, 40)}"`
  } else if (ev.event_type === 'http') {
    const hd = d as HttpData
    label = `${hd.method ?? ''} ${(hd.url ?? '').slice(0, 60)} ${hd.status_code ?? ''}`
  } else if (ev.event_type === 'file') {
    const fd = d as FileData
    label = `${fd.action ?? ''} ${(fd.path ?? '').split('/').slice(-2).join('/')}`
  } else if (ev.event_type === 'screen_tick') {
    // screen_tick events carry a screenshot + url in data (from fov.py).
    // Show the page URL as the label; the screenshot renders in the expanded view.
    const sd = d as BrowserData
    label = (sd.url ?? '').slice(0, 60) || 'screenshot'
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

      {expanded && hasTokens && typeof accumulated === 'string' && (
        <div className="ml-7 text-xs text-zinc-400 font-mono bg-black/20 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
          {accumulated}
        </div>
      )}

      {expanded && hasScreenshot && typeof screenshot === 'string' && (
        <div className="ml-7 mt-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screenshot}
            alt={`browser screenshot — ${(d as BrowserData).url ?? ''}`}
            className="rounded-md border border-white/10 max-w-full"
            style={{ maxHeight: 300 }}
          />
          {(d as BrowserData).url && (
            <p className="text-zinc-500 text-xs mt-1 font-mono truncate">
              {(d as BrowserData).url}
            </p>
          )}
        </div>
      )}

      {expanded && ev.status === 'error' && (
        <div className="ml-7 text-xs text-red-400 font-mono bg-red-500/10 rounded p-2">
          {(d as BrowserData).error ?? (d as HttpData).error ?? 'Unknown error'}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function LiveActivity({ agentId, agentName }: Props) {
  // useAgentEvents reads from the shared RealtimeProvider — the channel stays
  // open even when this component unmounts (page navigation). On return, events
  // that arrived during navigation are already in the store.
  const { events, connected, error } = useAgentEvents(agentId)

  const [filter, setFilter]   = useState<string>('all')
  const bottomRef  = useRef<HTMLDivElement>(null)

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
        {(['all', 'browser', 'llm_token', 'http', 'file', 'screen_tick'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap transition-colors
              ${filter === f
                ? 'bg-white/15 text-white'
                : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {f === 'all'
              ? `all (${events.length})`
              : `${ICONS[f]} ${f} (${counts[f] ?? 0})`}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <p className="text-sm text-red-400 font-medium">Couldn&apos;t load agent activity</p>
            <p className="text-xs text-zinc-600 mt-1 max-w-xs">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
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
