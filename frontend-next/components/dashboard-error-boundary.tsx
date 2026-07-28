'use client'

import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface State { hasError: boolean; message: string; eventId: string | null }

/**
 * Optional error reporting hook. If `NEXT_PUBLIC_ERROR_REPORTING_ENDPOINT`
 * is set, errors are POSTed to it (e.g. a Sentry ingest URL, a custom
 * /api/errors route, or a Logflare endpoint). If not set, errors are only
 * logged to the console — matching the previous behavior so dev/preview
 * environments without a reporting endpoint aren't broken.
 *
 * The hook is called from componentDidCatch so the error + React component
 * stack are both captured. We generate a short `eventId` so the UI can
 * display a reference the user can quote when reporting an issue manually.
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
    // Reporting failed — don't throw, the boundary should still render.
    return null
  }
}

export class DashboardErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, message: '', eventId: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message, eventId: null }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Always log to console — devs expect to see errors in DevTools even
    // when a reporting endpoint is configured.
    console.error('[DashboardErrorBoundary]', error, info)
    // Fire-and-forget the report; update state with the event id once it
    // resolves so the UI can show a reference code.
    reportError(error, info).then((eventId) => {
      if (eventId) this.setState({ eventId })
    })
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
