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
      // silently fail — unauthenticated pages or network errors
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load on mount. All setState calls are inside the async function
  // (after the first await), NOT synchronous in the effect body — avoids
  // the cascading-render lint violation. `refresh` is kept as a useCallback
  // for manual refresh from the settings page.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/settings/integrations')
        if (cancelled) return
        if (res.ok) {
          const data = await res.json()
          if (cancelled) return
          setIntegrations(data.integrations || [])
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setLoading(false)
      }
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
