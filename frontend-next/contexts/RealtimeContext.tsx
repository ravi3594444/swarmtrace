'use client'

/**
 * Keeps Supabase Realtime subscriptions alive across page navigations.
 * Mounted in DashboardLayout.
 *
 * Auth uses Clerk's getToken(); Supabase validates the token through Clerk's
 * JWKS, which the RLS policies need (see supabase/migrations/0005). The Clerk
 * domain must be enabled in Supabase under Authentication > Providers > Clerk.
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

interface BrowserData  { method?: string; url?: string; args?: string[]; screenshot?: string; error?: string }
interface LlmTokenData { token?: string; accumulated?: string }
interface HttpData     { method?: string; url?: string; status_code?: number; error?: string }
interface FileData     { action?: string; path?: string }
export type EventData  = BrowserData | LlmTokenData | HttpData | FileData

export interface AgentEvent {
  id: string
  agent_id: string
  agent_name: string
  event_type: 'browser' | 'llm_token' | 'http' | 'file' | 'screen_tick'
  status: 'started' | 'done' | 'error' | 'streaming' | 'info'
  data: EventData
  timestamp: string
}

interface AgentChannel {
  channel: RealtimeChannel
  events: AgentEvent[]
  connected: boolean
  error: string | null    // set if the history fetch or subscription failed
  subscribers: number   // ref-count
  lastUsed: number      // epoch ms of last subscribe, for LRU eviction
}

interface RealtimeContextValue {
  subscribe:   (agentId: string) => void
  unsubscribe: (agentId: string) => void
  getEvents:   (agentId: string) => AgentEvent[]
  isConnected: (agentId: string) => boolean
  getError:    (agentId: string) => string | null
  // bumps when events for a given agent change
  version:     Record<string, number>
}

const MAX_EVENTS_PER_AGENT = 300

// Max channels cached at 0 subscribers; oldest are evicted past this.
const MAX_CACHED_CHANNELS = 20

const RealtimeContext = createContext<RealtimeContextValue>({
  subscribe:   () => {},
  unsubscribe: () => {},
  getEvents:   () => [],
  isConnected: () => false,
  getError:    () => null,
  version:     {},
})

// Clerk JWTs last about an hour and Realtime silently stops receiving events
// once the cached client's token goes stale, so rebuild every 45 minutes.
const SB_TTL_MS = 45 * 60 * 1000

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState<Record<string, number>>({})
  const channels = useRef<Record<string, AgentChannel>>({})
  const sb        = useRef<SupabaseClient | null>(null)
  // When the cached client was built, to detect token expiry.
  const sbBuiltAt = useRef<number>(0)
  const { getToken } = useAuth()

  // Build (or refresh) a Supabase client authenticated with the current Clerk JWT.
  const getClient = useCallback(async (): Promise<SupabaseClient | null> => {
    const url  = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !anon) return null

    // Reuse the cached client while it's fresh.
    if (sb.current && Date.now() - sbBuiltAt.current < SB_TTL_MS) return sb.current

    // Token expired or no client yet: rebuild with a fresh token and tear
    // down existing channels so they re-subscribe with it.
    if (sb.current) {
      Object.values(channels.current).forEach(c => {
        if (c.channel) sb.current!.removeChannel(c.channel)
      })
      sb.current = null
    }

    try {
      // getToken() with no template returns the standard Clerk session
      // token, which Supabase validates against Clerk's JWKS.
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

  // Tear down all channels on provider unmount
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
    if (!client) {
      if (channels.current[agentId]) {
        channels.current[agentId].error =
          'Realtime unavailable — Supabase client could not be initialized.'
        bump(agentId)
      }
      return
    }

    // Load recent history first. Surface the error so a failed fetch doesn't
    // leave the feed silently empty.
    const { data, error } = await client
      .from('agent_events')
      .select('*')
      .eq('agent_id', agentId)
      .order('timestamp', { ascending: false })
      .limit(50)

    if (channels.current[agentId]) {
      if (error) {
        channels.current[agentId].error =
          `Couldn't load agent events: ${error.message}`
      } else if (data) {
        channels.current[agentId].events = (data as AgentEvent[]).reverse()
        channels.current[agentId].error = null
      }
      bump(agentId)
    }

    // Realtime channel
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
      // Already open, just bump the count and lastUsed.
      channels.current[agentId].subscribers += 1
      channels.current[agentId].lastUsed = Date.now()
      return
    }
    // Create the slot synchronously so concurrent calls don't double-open.
    channels.current[agentId] = {
      channel: null as unknown as RealtimeChannel,  // filled by openChannel
      events: [],
      connected: false,
      error: null,
      subscribers: 1,
      lastUsed: Date.now(),
    }
    openChannel(agentId)

    // Evict the oldest 0-subscriber channels once there are more than
    // MAX_CACHED_CHANNELS. Active channels are never evicted.
    const cached = Object.entries(channels.current)
      .filter(([, ch]) => ch.subscribers <= 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    if (cached.length > MAX_CACHED_CHANNELS) {
      const toEvict = cached.slice(0, cached.length - MAX_CACHED_CHANNELS)
      for (const [id, ch] of toEvict) {
        if (ch.channel && sb.current) sb.current.removeChannel(ch.channel)
        delete channels.current[id]
      }
    }
  }, [openChannel])

  const unsubscribe = useCallback((agentId: string) => {
    const ch = channels.current[agentId]
    if (!ch) return
    ch.subscribers -= 1
    // Channel stays alive at 0 subscribers so it survives navigation; it's
    // only torn down when the provider unmounts.
  }, [])

  const getEvents   = useCallback((agentId: string) => channels.current[agentId]?.events ?? [], [])
  const isConnected = useCallback((agentId: string) => channels.current[agentId]?.connected ?? false, [])
  const getError    = useCallback((agentId: string) => channels.current[agentId]?.error ?? null, [])

  return (
    <RealtimeContext.Provider value={{ subscribe, unsubscribe, getEvents, isConnected, getError, version }}>
      {children}
    </RealtimeContext.Provider>
  )
}

/**
 * Returns { events, connected, error } for one agent. The underlying channel
 * stays open after unmount.
 */
export function useAgentEvents(agentId: string) {
  const ctx = useContext(RealtimeContext)

  useEffect(() => {
    ctx.subscribe(agentId)
    return () => ctx.unsubscribe(agentId)
  }, [agentId, ctx])

  // version[agentId] bumps when events change
  const _tick = ctx.version[agentId]

  return {
    events:    ctx.getEvents(agentId),
    connected: ctx.isConnected(agentId),
    error:     ctx.getError(agentId),
  }
}

/**
 * Like useAgentEvents but for many agents at once (e.g. the network map).
 * Returns the latest status per agent: 'RUNNING' while the newest event is
 * started/streaming, 'ERROR' on error, null once done.
 *
 * Only covers agent ids you pass in, so pair it with a periodic topology
 * re-fetch (see lib/use-agent-graph.ts) to pick up new agents.
 */
export function useAgentPresence(agentIds: string[]): Record<string, { status: 'RUNNING' | 'ERROR' | null; lastEventAt: string | null }> {
  const ctx = useContext(RealtimeContext)
  const idsKey = agentIds.join(',')

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : []
    ids.forEach((id) => ctx.subscribe(id))
    return () => { ids.forEach((id) => ctx.unsubscribe(id)) }
    // idsKey is a stable string derived from the id list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const ids = idsKey ? idsKey.split(',') : []
  // Reading version[id] for each id is what re-renders us on updates, same as useAgentEvents.
  const _tick = ids.map((id) => ctx.version[id]).join(',')

  const presence: Record<string, { status: 'RUNNING' | 'ERROR' | null; lastEventAt: string | null }> = {}
  for (const id of ids) {
    const events = ctx.getEvents(id)
    const latest = events[events.length - 1]
    if (!latest) {
      presence[id] = { status: null, lastEventAt: null }
      continue
    }
    const status = latest.status === 'error' ? 'ERROR' : latest.status === 'done' ? null : 'RUNNING'
    presence[id] = { status, lastEventAt: latest.timestamp }
  }
  return presence
}
