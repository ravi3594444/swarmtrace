'use client'

/**
 * RealtimeContext — persists Supabase Realtime channel subscriptions across
 * page navigations. Lives in DashboardLayout (above every dashboard page) so
 * channels survive route changes.
 *
 * Problem it solves
 * -----------------
 * Without this, each LiveActivity component creates and destroys its own
 * Supabase channel inside useEffect. Navigating away from /agents unmounts
 * the component → channel is torn down → real-time events are lost → on
 * return the user sees "connecting…" again and any events that arrived
 * during navigation are gone.
 *
 * Solution
 * --------
 * A single shared channel per agentId, stored in this context. Components
 * call useAgentEvents(agentId) to subscribe — they receive a live-updating
 * array of events, but the channel itself is never torn down just because a
 * component unmounts. Channels are only cleaned up when the provider itself
 * unmounts (i.e. the user logs out or closes the tab).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

// ── Types ────────────────────────────────────────────────────────────────────

interface BrowserData  { method?: string; url?: string; args?: string[]; screenshot?: string; error?: string }
interface LlmTokenData { token?: string; accumulated?: string }
interface HttpData     { method?: string; url?: string; status_code?: number; error?: string }
interface FileData     { action?: string; path?: string }
export type EventData  = BrowserData | LlmTokenData | HttpData | FileData

export interface AgentEvent {
  id: string
  agent_id: string
  agent_name: string
  event_type: 'browser' | 'llm_token' | 'http' | 'file'
  status: 'started' | 'done' | 'error' | 'streaming' | 'info'
  data: EventData
  timestamp: string
}

interface AgentChannel {
  channel: RealtimeChannel
  events: AgentEvent[]
  connected: boolean
  subscribers: number   // ref-count so we know when to *stop* garbage-collecting
}

interface RealtimeContextValue {
  subscribe:   (agentId: string) => void
  unsubscribe: (agentId: string) => void
  getEvents:   (agentId: string) => AgentEvent[]
  isConnected: (agentId: string) => boolean
  // notifies components when events for a specific agent change
  version:     Record<string, number>
}

const MAX_EVENTS_PER_AGENT = 300

// ── Context ──────────────────────────────────────────────────────────────────

const RealtimeContext = createContext<RealtimeContextValue>({
  subscribe:   () => {},
  unsubscribe: () => {},
  getEvents:   () => [],
  isConnected: () => false,
  version:     {},
})

// ── Provider ─────────────────────────────────────────────────────────────────

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  // version[agentId] bumps on every new event — components re-render only
  // when their specific agent gets a new event, not on any event.
  const [version, setVersion] = useState<Record<string, number>>({})
  const channels = useRef<Record<string, AgentChannel>>({})
  const sb       = useRef<SupabaseClient | null>(null)

  // Initialise Supabase client once
  useEffect(() => {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anon) return
    sb.current = createClient(url, anon)

    return () => {
      // Tear down all channels on provider unmount (logout / tab close)
      Object.values(channels.current).forEach(c => {
        sb.current?.removeChannel(c.channel)
      })
      channels.current = {}
    }
  }, [])

  const bump = useCallback((agentId: string) => {
    setVersion(v => ({ ...v, [agentId]: (v[agentId] ?? 0) + 1 }))
  }, [])

  const openChannel = useCallback(async (agentId: string) => {
    if (!sb.current) return
    const client = sb.current

    // Load recent history first
    const { data } = await client
      .from('agent_events')
      .select('*')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(50)

    if (data && channels.current[agentId]) {
      channels.current[agentId].events = (data as AgentEvent[]).reverse()
      bump(agentId)
    }

    // Open realtime channel
    const channel = client
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
          if (!channels.current[agentId]) return
          const prev = channels.current[agentId].events
          const next = [...prev, ev]
          channels.current[agentId].events =
            next.length > MAX_EVENTS_PER_AGENT ? next.slice(-MAX_EVENTS_PER_AGENT) : next
          bump(agentId)
        }
      )
      .subscribe(status => {
        if (!channels.current[agentId]) return
        const connected = status === 'SUBSCRIBED'
        channels.current[agentId].connected = connected
        bump(agentId)
      })

    if (channels.current[agentId]) {
      channels.current[agentId].channel = channel
    }
  }, [bump])

  const subscribe = useCallback((agentId: string) => {
    if (channels.current[agentId]) {
      // Channel already open — just increment subscriber count
      channels.current[agentId].subscribers += 1
      return
    }
    // Create the slot synchronously so concurrent calls don't double-open
    channels.current[agentId] = {
      channel: null as unknown as RealtimeChannel,  // filled by openChannel
      events: [],
      connected: false,
      subscribers: 1,
    }
    openChannel(agentId)
  }, [openChannel])

  const unsubscribe = useCallback((agentId: string) => {
    const ch = channels.current[agentId]
    if (!ch) return
    ch.subscribers -= 1
    // Keep the channel alive even at 0 subscribers — the whole point of this
    // context is persistence across navigation. Only clean up on provider
    // unmount (handled in the useEffect above).
  }, [])

  const getEvents   = useCallback((agentId: string) => channels.current[agentId]?.events ?? [], [])
  const isConnected = useCallback((agentId: string) => channels.current[agentId]?.connected ?? false, [])

  return (
    <RealtimeContext.Provider value={{ subscribe, unsubscribe, getEvents, isConnected, version }}>
      {children}
    </RealtimeContext.Provider>
  )
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useAgentEvents(agentId)
 *
 * Returns { events, connected } for the given agent. Re-renders only when
 * that specific agent receives a new event, not on any global event.
 * The underlying Supabase channel is NOT torn down when the component unmounts.
 */
export function useAgentEvents(agentId: string) {
  const ctx = useContext(RealtimeContext)

  useEffect(() => {
    ctx.subscribe(agentId)
    return () => ctx.unsubscribe(agentId)
  }, [agentId, ctx])

  // Derive stable values. ctx.version[agentId] bumps when events change,
  // triggering a re-render here but nowhere else.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _tick = ctx.version[agentId]

  return {
    events:    ctx.getEvents(agentId),
    connected: ctx.isConnected(agentId),
  }
}
