'use client'

import { ReactNode } from 'react'

interface Props {
  title: string
  description?: string
  status?: { label: string; variant: 'active' | 'idle' | 'error' | 'info' }
  actions?: ReactNode
  badge?: string
}

const STATUS_STYLES = {
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  idle:   'bg-zinc-500/10   text-zinc-500   border-zinc-500/20',
  error:  'bg-red-500/10    text-red-500    border-red-500/20',
  info:   'bg-blue-500/10   text-blue-600   border-blue-500/20',
}

const DOT_STYLES = {
  active: 'bg-emerald-500',
  idle:   'bg-zinc-400',
  error:  'bg-red-500',
  info:   'bg-blue-500',
}

export function PageHeader({ title, description, status, actions, badge }: Props) {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10 h-14 shrink-0">
      {/* Left — title + status */}
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="text-sm font-semibold text-foreground tracking-tight truncate">
          {title}
        </h1>

        {badge && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 uppercase tracking-wide shrink-0">
            {badge}
          </span>
        )}

        {status && (
          <span className={`
            inline-flex items-center gap-1.5 text-xs font-medium
            px-2 py-0.5 rounded-full border shrink-0
            ${STATUS_STYLES[status.variant]}
          `}>
            <span className={`w-1.5 h-1.5 rounded-full ${DOT_STYLES[status.variant]} ${status.variant === 'active' ? 'animate-pulse' : ''}`} />
            {status.label}
          </span>
        )}

        {description && (
          <span className="text-xs text-muted-foreground hidden sm:block truncate">
            {description}
          </span>
        )}
      </div>

      {/* Right — actions */}
      {actions && (
        <div className="flex items-center gap-2 shrink-0 ml-4">
          {actions}
        </div>
      )}
    </div>
  )
}
