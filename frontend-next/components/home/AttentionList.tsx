'use client'

import Link from 'next/link'
import type { Trace } from '@/lib/trace-types'
import { clusterErrors } from '@/lib/error-clustering'
import { formatRelativeTime } from '@/lib/api'
import { AlertTriangle, CheckCircle, ArrowRight } from 'lucide-react'

/**
 * AttentionList — "What needs attention", the Home-page counterpart to the
 * developer Failures page. Reuses the same error clustering so the groups
 * shown here match what /failures shows, but each row is phrased for a
 * non-technical reader: the error type as a name, a plain count ("happened
 * 4 times"), and how long ago it last occurred — no stack traces, no raw
 * messages, no span terminology.
 *
 * When nothing is wrong, the section stays visible with a calm all-clear
 * row instead of disappearing — a section that vanishes teaches users the
 * layout is unstable; a persistent "nothing to do" row teaches them this
 * is where problems will show up.
 */
export function AttentionList({ traces }: { traces: Trace[] }) {
  const clusters = clusterErrors(traces).slice(0, 3)

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden transition-[background-color,border-color,color] duration-200">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">What needs attention</h3>
        </div>
        <span className="text-[11px] text-muted-foreground">today</span>
      </div>

      {clusters.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-5">
          <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <p className="text-sm text-muted-foreground">Nothing needs your attention right now.</p>
        </div>
      ) : (
        <>
          <div className="divide-y divide-border/50">
            {clusters.map((c) => (
              <div key={c.signature} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-1.5 w-2 h-2 rounded-full bg-destructive shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">{c.type}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    happened {c.count} {c.count === 1 ? 'time' : 'times'}
                    {c.functions[0] ? ` in ${c.functions[0]}` : ''}
                    {' · '}last seen {formatRelativeTime(c.lastSeen)}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border px-4 py-2.5">
            <Link
              href="/failures"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline underline-offset-2"
            >
              See details <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
