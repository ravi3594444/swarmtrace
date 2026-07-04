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

// Explicit colors — NOT theme variables. The FOV panel is always white with
// black text regardless of dashboard theme, so screenshots are always
// visible against a clean background. Users complained that theme-variable
// colors made text invisible in light mode.
const STATUS_COLOR: Record<string, string> = {
  started:   '#2563eb',  // blue-600
  done:      '#16a34a',  // green-600
  error:     '#dc2626',  // red-600
  streaming: '#9333ea',  // purple-600
  info:      '#52525b',  // zinc-600
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
      className="fixed inset-0 z-[60] flex items-center justify-center fade-in"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`screenshot — ${url ?? ''}`}
          style={{
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.2)',
            maxWidth: '90vw',
            maxHeight: '80vh',
            objectFit: 'contain',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}
        />
        {url && (
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'monospace', maxWidth: '90vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {url}
          </p>
        )}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: -12,
            right: -12,
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'white',
            color: 'black',
            border: 'none',
            cursor: 'pointer',
            fontSize: 18,
            fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
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
      style={{
        display: 'flex',
        flexDirection: 'column' as const,
        gap: 4,
        padding: '8px 12px',
        borderRadius: 8,
        cursor: hasExpandable ? 'pointer' : 'default',
        background: ev.status === 'error' ? 'rgba(220,38,38,0.05)' : 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => { if (hasExpandable) (e.currentTarget as HTMLElement).style.background = ev.status === 'error' ? 'rgba(220,38,38,0.08)' : '#f4f4f5' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ev.status === 'error' ? 'rgba(220,38,38,0.05)' : 'transparent' }}
      onClick={() => hasExpandable && setExpanded(e => !e)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        {/* Thumbnail for screen_tick + browser events with screenshots */}
        {hasScreenshot ? (
          <button
            onClick={(e) => { e.stopPropagation(); onScreenshotClick(screenshot!, (d as BrowserData).url) }}
            style={{
              flexShrink: 0,
              width: 48,
              height: 32,
              borderRadius: 4,
              border: '1px solid #e4e4e7',
              overflow: 'hidden',
              cursor: 'pointer',
              padding: 0,
              background: '#000',
            }}
            title="Click to view full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screenshot} alt="thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ) : (
          <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{ICONS[ev.event_type] ?? '●'}</span>
        )}
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: STATUS_COLOR[ev.status] ?? '#52525b', flexShrink: 0, fontWeight: 600 }}>
          {ev.status}
        </span>
        <span style={{ color: '#18181b', flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ color: '#a1a1aa', fontSize: 11, flexShrink: 0, marginLeft: 8 }}>{ts}</span>
        {hasExpandable && (
          <span style={{ color: '#71717a', fontSize: 11, flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        )}
      </div>

      {/* Expanded: LLM accumulated tokens */}
      {expanded && hasTokens && typeof accumulated === 'string' && (
        <div style={{ marginLeft: 28, fontSize: 11, fontFamily: 'monospace', color: '#52525b', background: '#f4f4f5', borderRadius: 4, padding: 8, whiteSpace: 'pre-wrap', maxHeight: 128, overflowY: 'auto' }}>
          {accumulated}
        </div>
      )}

      {/* Expanded: screenshot preview (click opens lightbox) */}
      {expanded && hasScreenshot && typeof screenshot === 'string' && (
        <div style={{ marginLeft: 28, marginTop: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onScreenshotClick(screenshot, (d as BrowserData).url) }}
            style={{ display: 'block', border: '1px solid #e4e4e7', borderRadius: 6, padding: 0, cursor: 'pointer', background: 'transparent' }}
            title="Click to view full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={screenshot}
              alt={`screenshot — ${(d as BrowserData).url ?? ''}`}
              style={{ borderRadius: 6, maxWidth: '100%', maxHeight: 300, display: 'block' }}
            />
          </button>
          {(d as BrowserData).url && (
            <p style={{ color: '#71717a', fontSize: 11, fontFamily: 'monospace', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(d as BrowserData).url}
            </p>
          )}
        </div>
      )}

      {/* Expanded: error details */}
      {expanded && ev.status === 'error' && (
        <div style={{ marginLeft: 28, fontSize: 11, fontFamily: 'monospace', color: '#dc2626', background: 'rgba(220,38,38,0.08)', borderRadius: 4, padding: 8 }}>
          {(d as BrowserData).error ?? (d as HttpData).error ?? 'Unknown error'}
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function LiveActivity({ agentId, agentName }: Props) {
  const { events, connected, error } = useAgentEvents(agentId)

  const [filter, setFilter] = useState<string>('all')
  const [lightbox, setLightbox] = useState<{ src: string; url?: string } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column' as const,
        height: '100%',
        background: '#ffffff',
        borderRadius: 12,
        border: '1px solid #e4e4e7',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e4e4e7', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: connected ? '#22c55e' : '#d4d4d8',
              animation: connected ? 'pulse 1.6s ease-in-out infinite' : 'none',
            }}
          />
          <span style={{ fontSize: 14, fontWeight: 500, color: '#18181b' }}>
            {agentName ?? agentId}
          </span>
          <span style={{ fontSize: 12, color: '#71717a' }}>
            {connected ? 'live' : 'connecting…'}
          </span>
        </div>
        <span style={{ fontSize: 12, color: '#71717a' }}>{events.length} events</span>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #f4f4f5', flexShrink: 0, overflowX: 'auto' }}>
        {(['all', 'browser', 'llm_token', 'http', 'file', 'screen_tick'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11,
              fontFamily: 'monospace',
              whiteSpace: 'nowrap',
              border: 'none',
              cursor: 'pointer',
              background: filter === f ? '#18181b' : 'transparent',
              color: filter === f ? '#ffffff' : '#71717a',
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => { if (filter !== f) (e.currentTarget as HTMLElement).style.color = '#18181b' }}
            onMouseLeave={e => { if (filter !== f) (e.currentTarget as HTMLElement).style.color = '#71717a' }}
          >
            {f === 'all'
              ? `all (${events.length})`
              : `${ICONS[f]} ${f} (${counts[f] ?? 0})`}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {error ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', padding: '0 24px' }}>
            <p style={{ fontSize: 14, color: '#dc2626', fontWeight: 500 }}>Couldn&apos;t load agent activity</p>
            <p style={{ fontSize: 12, color: '#71717a', marginTop: 4, maxWidth: 300 }}>{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#a1a1aa', fontSize: 14 }}>
            {connected ? 'Waiting for agent activity…' : 'Connecting to Supabase Realtime…'}
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
