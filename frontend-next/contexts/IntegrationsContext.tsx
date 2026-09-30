'use client'

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'

export type Integration = {
  id: string
  name: string
  description: string
  connected: boolean
  requires?: string | null
}

type IntegrationsContextValue = {
  integrations: Integration[]
  isEnabled: (id: string) => boolean
  loading: boolean
  refresh: () => Promise<void>
}

const IntegrationsContext = createContext<IntegrationsContextValue>({
  integrations: [],
  isEnabled: () => false,
  loading: true,
  refresh: async () => {},
})

export function IntegrationsProvider({ children }: { children: ReactNode }) {
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/integrations')
      if (res.ok) {
        const data = await res.json()
        setIntegrations(data.integrations || [])
      }
    } catch {
      // unauthenticated pages or network errors: fail quietly
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load on mount. setState only happens after the first await, to
  // keep the cascading-render lint rule happy. `refresh` stays a useCallback
  // for the settings page.
  useEffect(() => {
    let cancelled = false
    const attempt = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/settings/integrations')
        if (cancelled) return true
        if (res.ok) {
          const data = await res.json()
          if (cancelled) return true
          setIntegrations(data.integrations || [])
          return true
        }
        return false
      } catch {
        return false
      }
    }
    const load = async () => {
      // the first request can race session setup right after sign-in, so
      // retry a couple of times with a short backoff
      for (let i = 0; i < 3; i++) {
        if (await attempt()) break
        if (cancelled) return
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
        if (cancelled) return
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const isEnabled = useCallback(
    (id: string) => integrations.find(i => i.id === id)?.connected ?? false,
    [integrations]
  )

  return (
    <IntegrationsContext.Provider value={{ integrations, isEnabled, loading, refresh }}>
      {children}
    </IntegrationsContext.Provider>
  )
}

export function useIntegrations() {
  return useContext(IntegrationsContext)
}
