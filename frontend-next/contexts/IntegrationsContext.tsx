'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

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

export function IntegrationsProvider({ children }: { children: React.ReactNode }) {
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

  useEffect(() => { refresh() }, [refresh])

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
