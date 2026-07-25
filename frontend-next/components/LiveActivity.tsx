'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useAgentEvents, AgentEvent, EventData } from '@/contexts/RealtimeContext'

// ── Per-event data shapes ────────────────────────────────────────────────────
interface BrowserData  { method?: string; url?: string; args?: string[]; screenshot?: string; error?: string }
interface LlmTokenData { token?: string; accumulated?: string }
interface HttpData     { method?: string; url?: string; status_code?: number; error?: string }
interface FileData     { action?: string; path?: string }

interface Props {
  agentId: string
  agentName?: string
  maxEvents?: number
}

// ── Icons ───────────────────────────────────────────────────────────────────
const ICONS: Record<string, string> = {
  browser:     '🌐',
  llm_token:   '✨',
  http:        '🔗',
  file:        '📄',
  screen_tick: '📸',
}

// Use CSS variables so the component works in BOTH light and dark mode.
// The old code hardcoded text-zinc-300/500 and bg-black/20 which are
// invisible on a light background (the dashboard default).
const STATUS_COLOR: Record<string, string> = {
  started:   'text-blue-500 dark:text-blue-400',
  done:      'text-green-600 dark:text-green-400 dark:text-green-400',
  error:     'text-red-500 dark:text-red-400',
  streaming: 'text-purple-500 dark:text-purple-400',
  info:      'text-muted-foreground',
}

// ── Full-size screenshot lightbox ───────────────────────────────────────────
function ScreenshotLightbox({ src, url, onClose }: { src: string; url?: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', h)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm fade-in"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`screenshot — ${url ?? ''}`}
          className="rounded-lg border border-white/20 shadow-2xl max-w-full max-h-[80vh] object-contain"
        />
        {url && (
          <p className="text-white/70 text-xs font-mono truncate max-w-full">{url}</p>
        )}
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white text-black flex items-center justify-center shadow-lg hover:bg-white/90 transition-colors text-lg font-bold"
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </div>
  )
}

// ── Event row ───────────────────────────────────────────────────────────────
function EventRow({ ev, onScreenshotClick }: { ev: AgentEvent; onScreenshotClick: (src: string, url?: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const d = ev.data as EventData

  const screenshot  = (d as BrowserData).screenshot
  const accumulated = (d as LlmTokenData).accumulated
  const hasScreenshot = typeof screenshot === 'string' && screenshot.startsWith('data:')
  const hasTokens     = ev.event_type === 'llm_token' && typeof accumulated === 'string'
  const hasExpandable = hasScreenshot || hasTokens || ev.status === 'error'

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
    const sd = d as BrowserData
    label = (sd.url ?? '').slice(0, 60) || 'screenshot'
  }

  const ts = new Date(ev.timestamp).toLocaleTimeString([], { hour12: false })

  return (
    <div
      className={`group flex flex-col gap-1 px-3 py-2 rounded-lg transition-colors
        ${hasExpandable ? 'cursor-pointer' : ''}
        ${ev.status === 'error'
          ? 'bg-red-500/10 hover:bg-red-500/15 dark:bg-red-500/10 dark:hover:bg-red-500/15'
          : 'hover:bg-muted/60'}`}
      onClick={() => hasExpandable && setExpanded(e => !e)}
    >
      <div className="flex items-center gap-2 text-sm">
        {/* Thumbnail for screen_tick events — visible even when collapsed */}
        {ev.event_type === 'screen_tick' && hasScreenshot ? (
          <button
            onClick={(e) => { e.stopPropagation(); onScreenshotClick(screenshot!, (d as BrowserData).url) }}
            className="shrink-0 w-12 h-8 rounded border border-border overflow-hidden hover:ring-2 hover:ring-primary transition-all"
            title="Click to view full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screenshot} alt="thumbnail" className="w-full h-full object-cover" />
          </button>
        ) : (
          <span className="text-base leading-none shrink-0">{ICONS[ev.event_type] ?? '●'}</span>
        )}
        <span className={`text-xs font-mono shrink-0 ${STATUS_COLOR[ev.status] ?? 'text-muted-foreground'}`}>{ev.status}</span>
        <span className="text-foreground/80 flex-1 truncate font-mono text-xs">{label}</span>
        <span className="text-muted-foreground text-xs shrink-0 ml-2">{ts}</span>
        {hasExpandable && (
          <span className="text-muted-foreground text-xs shrink-0 group-hover:text-foreground transition-colors">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </div>

      {/* Expanded: LLM accumulated tokens */}
      {expanded && hasTokens && typeof accumulated === 'string' && (
        <div className="ml-7 text-xs text-muted-foreground font-mono bg-muted/40 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
          {accumulated}
        </div>
      )}

      {/* Expanded: screenshot preview (click opens lightbox) */}
      {expanded && hasScreenshot && typeof screenshot === 'string' && (
        <div className="ml-7 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); onScreenshotClick(screenshot, (d as BrowserData).url) }}
            className="block hover:opacity-90 transition-opacity"
            title="Click to view full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={screenshot}
              alt={`screenshot — ${(d as BrowserData).url ?? ''}`}
              className="rounded-md border border-border max-w-full"
              style={{ maxHeight: 300 }}
            />
          </button>
          {(d as BrowserData).url && (
            <p className="text-muted-foreground text-xs mt-1 font-mono truncate">
              {(d as BrowserData).url}
            </p>
          )}
        </div>
      )}

      {/* Expanded: error details */}
      {expanded && ev.status === 'error' && (
        <div className="ml-7 text-xs text-red-500 dark:text-red-400 font-mono bg-red-500/10 dark:bg-red-500/10 rounded p-2">
          {(d as BrowserData).error ?? (d as HttpData).error ?? 'Unknown error'}
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function LiveActivity({ agentId, agentName }: Props) {
  const { events, connected, error } = useAgentEvents(agentId)

  const [filter, setFilter]   = useState<string>('all')
  const [lightbox, setLightbox] = useState<{ src: string; url?: string } | null>(null)
  const bottomRef  = useRef<HTMLDivElement>(null)

  const openLightbox = useCallback((src: string, url?: string) => {
    setLightbox({ src, url })
  }, [])

  const closeLightbox = useCallback(() => {
    setLightbox(null)
  }, [])

  const filtered = filter === 'all'
    ? events
    : events.filter(e => e.event_type === filter)

  const counts = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.event_type] = (acc[e.event_type] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full bg-card rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/40'}`}
          />
          <span className="text-sm font-medium text-foreground">
            {agentName ?? agentId}
          </span>
          <span className="text-xs text-muted-foreground">
            {connected ? 'live' : 'connecting…'}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{events.length} events</span>
      </div>

      {/* Filter bar */}
      <div className="flex gap-1 px-3 py-2 border-b border-border/50 shrink-0 overflow-x-auto scrollbar-thin">
        {(['all', 'browser', 'llm_token', 'http', 'file', 'screen_tick'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 rounded text-xs font-mono whitespace-nowrap transition-colors
              ${filter === f
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground'}`}
          >
            {f === 'all'
              ? `all (${events.length})`
              : `${ICONS[f]} ${f} (${counts[f] ?? 0})`}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto py-1 scrollbar-thin">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <p className="text-sm text-red-500 dark:text-red-400 font-medium">Couldn&apos;t load agent activity</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {connected ? 'Waiting for agent activity…' : 'Connecting to live feed…'}
          </div>
        ) : (
          filtered.map(ev => <EventRow key={ev.id} ev={ev} onScreenshotClick={openLightbox} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Full-size screenshot lightbox */}
      {lightbox && (
        <ScreenshotLightbox src={lightbox.src} url={lightbox.url} onClose={closeLightbox} />
      )}
    </div>
  )
}
