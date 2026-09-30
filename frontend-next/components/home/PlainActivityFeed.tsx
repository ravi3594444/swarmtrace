'use client'

import Link from 'next/link'
import type { Trace } from '@/lib/trace-types'
import { rootTraces } from './SimpleStatCards'
import { Activity } from 'lucide-react'

/**
 * "Recent activity" on the Home page: one plain sentence per request, each
 * linking to /traces. Times are local (the developer tables use UTC).
 */
function formatLocalTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function PlainActivityFeed({ traces }: { traces: Trace[] }) {
  const recent = rootTraces(traces)
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 8)

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Recent activity</h3>
        </div>
        <span className="text-[11px] text-muted-foreground">today</span>
      </div>

      {recent.length === 0 ? (
        <div className="px-4 py-5">
          <p className="text-sm text-muted-foreground">No activity yet today — new requests will appear here automatically.</p>
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {recent.map((t) => {
            const failed = !!t.error
            const name = t.agent_name || t.function || 'A request'
            return (
              <Link
                key={t.id}
                href="/traces"
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${failed ? 'bg-destructive' : 'bg-emerald-500'}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground truncate">
                    <span className="font-medium">{name}</span>
                    {' '}
                    <span className={failed ? 'text-destructive' : 'text-muted-foreground'}>
                      {failed ? 'ran into an issue' : `answered in ${(t.latency_sec ?? 0).toFixed(1)}s`}
                    </span>
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {formatLocalTime(t.timestamp)}
                </span>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
