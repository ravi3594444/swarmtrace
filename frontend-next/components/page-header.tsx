'use client'

import { ReactNode, useState, useEffect } from 'react'
import { Search, RefreshCw, ChevronRight } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { openCommandPalette } from '@/components/command-palette'

/**
 * A single breadcrumb crumb. Either a link (href) or plain text.
 * The last crumb is rendered as plain text (the current page).
 */
export interface Breadcrumb {
  label: string
  href?: string
}

/**
 * RelativeTime — ticks every second to show "3s ago", "45s ago", etc.
 * Kept inline (not a separate file) because it's only used here.
 */
function RelativeTime({ date }: { date: Date }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const seconds = Math.floor((now - date.getTime()) / 1000)
  if (seconds < 5) return <span>just now</span>
  if (seconds < 60) return <span>{seconds}s ago</span>
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return <span>{minutes}m ago</span>
  const hours = Math.floor(minutes / 60)
  return <span>{hours}h ago</span>
}

export function PageHeader({
  title, description, badge, liveStatus, actions,
  lastUpdated, onRefresh, breadcrumbs,
}: {
  title: string
  description?: string
  badge?: ReactNode
  liveStatus?: 'live' | 'paused' | 'offline'
  actions?: ReactNode
  /** When the data on this page was last fetched. Shows "Xs ago" ticking. */
  lastUpdated?: Date | null
  /** Callback for a manual refresh button. If omitted, no refresh button. */
  onRefresh?: () => void
  /** Optional breadcrumbs for context (e.g. Traces → trace_id). The last
   *  crumb is rendered as plain text; earlier crumbs are links if `href`
   *  is provided. When omitted, no breadcrumb row is shown. */
  breadcrumbs?: Breadcrumb[]
}) {
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = () => {
    if (refreshing || !onRefresh) return
    setRefreshing(true)
    onRefresh()
    // Reset after 1s — the actual fetch may take longer, but the spinner
    // gives visual feedback that the click was registered.
    setTimeout(() => setRefreshing(false), 1000)
  }

  return (
    <div className="sticky top-0 z-20 bg-background/90 backdrop-blur-sm border-b border-border px-6 py-4 flex items-center justify-between gap-4 transition-[background-color,border-color,color] duration-200">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {breadcrumbs.map((bc, i) => {
                const isLast = i === breadcrumbs.length - 1
                return (
                  <li key={i} className="flex items-center gap-1">
                    {bc.href && !isLast ? (
                      <a href={bc.href} className="hover:text-foreground transition-colors truncate max-w-[160px]">
                        {bc.label}
                      </a>
                    ) : (
                      <span className={isLast ? "text-foreground font-medium truncate max-w-[200px]" : "truncate max-w-[160px]"}>
                        {bc.label}
                      </span>
                    )}
                    {!isLast && <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/50" />}
                  </li>
                )
              })}
            </ol>
          </nav>
        )}
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-foreground truncate">{title}</h1>
          {badge && (
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wide shrink-0">
              {badge}
            </span>
          )}
          {liveStatus && (
            <div className={`flex items-center gap-1.5 text-xs font-medium ${
              liveStatus === 'live' ? 'text-foreground' : 'text-muted-foreground'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                liveStatus === 'live' ? 'bg-emerald-500 swarm-pulse' :
                liveStatus === 'paused' ? 'bg-amber-400' : 'bg-muted-foreground'
              }`} />
              {liveStatus === 'live' ? 'LIVE' : liveStatus === 'paused' ? 'PAUSED' : 'OFFLINE'}
            </div>
          )}
          {/* Last-updated timestamp — ticks every second */}
          {lastUpdated && (
            <span className="hidden sm:inline text-[11px] text-muted-foreground/70 font-mono">
              Updated <RelativeTime date={lastUpdated} />
            </span>
          )}
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{description}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {/* Manual refresh button */}
        {onRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh now"
            aria-label="Refresh now"
            className="flex items-center justify-center h-8 w-8 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-zinc-300 dark:hover:border-zinc-600 transition-[background-color,border-color,color] duration-200 shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
        <button
          type="button"
          data-tour="global-search"
          onClick={openCommandPalette}
          title="Search (Ctrl+K)"
          aria-label="Open search"
          className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-zinc-300 dark:hover:border-zinc-600 transition-[background-color,border-color,color] duration-200 shadow-sm"
        >
          <Search className="w-3.5 h-3.5" />
          <kbd className="text-[11px] border border-border rounded px-1 py-px">Ctrl K</kbd>
        </button>
        <ThemeToggle />
      </div>
    </div>
  )
}
