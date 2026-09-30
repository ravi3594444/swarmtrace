'use client'

import React from 'react'
import { usePathname } from 'next/navigation'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface State { hasError: boolean; message: string; eventId: string | null }

/**
 * POSTs the error to NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT if set, and returns
 * an event id the UI can show. Without an endpoint it does nothing.
 */
async function reportError(error: Error, info: React.ErrorInfo): Promise<string | null> {
  const endpoint = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT
  if (!endpoint) return null
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        url: typeof window !== 'undefined' ? window.location.href : '',
        timestamp: new Date().toISOString(),
      }),
    })
    const data = await res.json().catch(() => null)
    return data?.eventId ?? data?.id ?? crypto.randomUUID?.() ?? null
  } catch {
    // Reporting failed; the boundary should still render.
    return null
  }
}

/**
 * Catches render errors in the page content so the sidebar and palette stay
 * usable. The class can't call hooks, so a thin wrapper passes usePathname()
 * as `resetKey`, and the error clears when the route changes.
 */
export class DashboardErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; resetKey: string },
  State
> {
  constructor(props: { children: React.ReactNode; resetKey: string }) {
    super(props)
    this.state = { hasError: false, message: '', eventId: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message, eventId: null }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[DashboardErrorBoundary]', error, info)
    // Fire and forget; the event id is shown once it resolves.
    reportError(error, info).then((eventId) => {
      if (eventId) this.setState({ eventId })
    })
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    // Route changed, give the new page a fresh render.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4 p-8 text-center">
        <div className="w-12 h-12 rounded-full border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 flex items-center justify-center">
          <AlertTriangle className="w-5 h-5 text-red-500" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground mb-1">Something went wrong</p>
          {this.state.message && (
            <p className="text-xs text-muted-foreground font-mono max-w-sm">{this.state.message}</p>
          )}
          {this.state.eventId && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Error ID: <span className="font-mono">{this.state.eventId}</span>
            </p>
          )}
        </div>
        <button
          onClick={() => {
            this.setState({ hasError: false, message: '', eventId: null })
            // Hard reload is the most reliable way to recover from a render
            // error: it clears any cached route segment, re-runs server
            // components, and re-fetches client data. A soft `router.refresh()`
            // alone doesn't always clear a thrown render in the App Router.
            window.location.reload()
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-card text-sm text-foreground hover:bg-muted/60 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reload page
        </button>
      </div>
    )
  }
}

/** Functional wrapper that feeds the current pathname to the class boundary. */
export function DashboardErrorBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <DashboardErrorBoundaryInner resetKey={pathname ?? '/'}>
      {children}
    </DashboardErrorBoundaryInner>
  )
}
