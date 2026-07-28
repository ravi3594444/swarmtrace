'use client'

import React from 'react'
import { usePathname } from 'next/navigation'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface State { hasError: boolean; message: string }

/**
 * DashboardErrorBoundary — catches render-time errors inside the dashboard
 * page content area so a single page crash doesn't take down the whole app
 * shell (sidebar, command palette, etc. remain usable).
 *
 * RESET ON ROUTE CHANGE:
 * Class components can't use hooks directly, so we split the boundary into
 * the class itself (which holds the error state) and a thin functional
 * wrapper that reads `usePathname()` and passes it as a `resetKey`. When the
 * path changes, `componentDidUpdate` sees a new `resetKey` and clears the
 * error state — so a transient error on /traces doesn't persist after the
 * user navigates to /overview. Without this, a one-off render error would
 * "stick" until a full page reload, even though the underlying route segment
 * is different.
 */
export class DashboardErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; resetKey: string },
  State
> {
  constructor(props: { children: React.ReactNode; resetKey: string }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[DashboardErrorBoundary]', error, info)
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    // Route changed while an error was showing — clear it so the new page
    // gets a fresh chance to render. This is the fix for "transient error
    // persists across navigation" — without it, the boundary stays in its
    // error state until a full page reload, even though the user has moved
    // to a completely different route segment.
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
        </div>
        <button
          onClick={() => {
            this.setState({ hasError: false, message: '' })
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
