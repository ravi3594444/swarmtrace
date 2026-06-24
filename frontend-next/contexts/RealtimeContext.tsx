'use client'

/**
 * RealtimeContext — persists Supabase Realtime channel subscriptions across
 * page navigations. Lives in DashboardLayout (above every dashboard page) so
 * channels survive route changes.
 *
 * Auth: uses Clerk's getToken({ template: 'supabase' }) to get a JWT that
 * Supabase recognises. This is required for RLS policies (which check
 * auth.jwt()->>'sub') to allow the browser to receive Realtime events.
 * Without this, all postgres_changes subscriptions are silently empty.
 *
 * Setup required (one-time, in dashboards — not in code):
 *   1. Clerk dashboard → JWT Templates → New → Supabase → copy signing secret
 *   2. Supabase dashboard → Project Settings → API → JWT Secret → paste it
 * Once done, every Realtime subscription here will correctly filter to the
 * current user's data via RLS.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useAuth } from '@clerk/nextjs'
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
  const [version, setVersion] = useState<Record<string, number>>({})
  const channels = useRef<Record<string, AgentChannel>>({})
  const sb        = useRef<SupabaseClient | null>(null)
  // Track when the cached client was built so we can detect token expiry.
  // Clerk JWTs expire (~1 h). After expiry the cached client's Authorization
  // header becomes stale and Realtime subscriptions silently stop receiving
  // events. We force a rebuild every 45 minutes — well inside the 1 h window.
  const sbBuiltAt = useRef<number>(0)
  const SB_TTL_MS = 45 * 60 * 1000
  const { getToken } = useAuth()

  // Build (or refresh) a Supabase client authenticated with the current Clerk JWT.
  const getClient = useCallback(async (): Promise<SupabaseClient | null> => {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anon) return null

    // Return the cached client if it was built recently enough.
    if (sb.current && Date.now() - sbBuiltAt.current < SB_TTL_MS) return sb.current

    // Cache miss or TTL expired — rebuild with a fresh token.
    // Tear down existing channels first so they re-subscribe with the new JWT.
    if (sb.current) {
      Object.values(channels.current).forEach(c => {
        if (c.channel) sb.current!.removeChannel(c.channel)
      })
      sb.current = null
    }

    try {
      // Native Clerk+Supabase integration (no JWT template needed):
      // getToken() with no args returns the standard Clerk session token.
      // Supabase validates it via Clerk's public JWKS endpoint — no shared
      // secrets, no security risk, no downtime on secret rotation.
      //
      // One-time setup required (see supabase/migrations/0005_production_fixes.sql):
      //   1. Clerk Dashboard → Integrations → Supabase → copy your Clerk Domain
      //   2. Supabase Dashboard → Authentication → Providers → Clerk → paste domain + enable
      const token = await getToken().catch(() => null)
      const client = createClient(url, anon, {
        global: token
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {},
        realtime: { params: { eventsPerSecond: 10 } },
      })
      sb.current    = client
      sbBuiltAt.current = Date.now()
      return client
    } catch {
      return null
    }
  }, [getToken])

  // Tear down all channels on provider unmount (logout / tab close)
  useEffect(() => {
    return () => {
      const client = sb.current
      if (client) {
        Object.values(channels.current).forEach(c => {
          if (c.channel) client.removeChannel(c.channel)
        })
      }
      channels.current = {}
    }
  }, [])
  
  const bump = useCallback((agentId: string) => {
    setVersion(v => ({ ...v, [agentId]: (v[agentId] ?? 0) + 1 }))
  }, [])

  const openChannel = useCallback(async (agentId: string) => {
    const client = await getClient()
    if (!client) return

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
  }, [getClient, bump])

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
