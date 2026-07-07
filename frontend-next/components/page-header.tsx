'use client'

import { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { ThemeToggle } from '@/components/theme-toggle'
import { openCommandPalette } from '@/components/command-palette'

export function PageHeader({
  title, description, badge, liveStatus, actions,
}: {
  title: string
  description?: string
  badge?: ReactNode
  liveStatus?: 'live' | 'paused' | 'offline'
  actions?: ReactNode
}) {
  return (
    <div className="sticky top-0 z-20 bg-background/90 backdrop-blur-sm border-b border-border px-6 py-4 flex items-center justify-between gap-4 transition-[background-color,border-color,color] duration-200">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-foreground truncate">{title}</h1>
          {badge && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wide shrink-0">
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
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        <button
          type="button"
          onClick={openCommandPalette}
          title="Search (Ctrl+K)"
          aria-label="Open search"
          className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-zinc-300 dark:hover:border-zinc-600 transition-[background-color,border-color,color] duration-200 shadow-sm"
        >
          <Search className="w-3.5 h-3.5" />
          <kbd className="text-[10px] border border-border rounded px-1 py-px">Ctrl K</kbd>
        </button>
        <ThemeToggle />
      </div>
    </div>
  )
}
