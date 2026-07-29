'use client'

import { useMemo } from 'react'
import { Activity, ChevronRight } from 'lucide-react'
import type { Trace } from '@/lib/trace-types'
import {
  KIND_LABELS,
  buildArchitectureEdges,
  buildArchitectureLayers,
  formatCost,
  formatLatency,
  summarizeArchitecture,
} from '@/lib/architecture-summary'

export function ExecutionArchitecture({
  traces,
  selected,
  onSelect,
}: {
  traces: Trace[]
  selected: Trace | null
  onSelect: (t: Trace) => void
}) {
  const layers = useMemo(() => buildArchitectureLayers(traces), [traces])
  const edges = useMemo(() => buildArchitectureEdges(traces), [traces])
  const summary = useMemo(() => summarizeArchitecture(traces), [traces])

  if (traces.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <Activity className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
        <h3 className="text-sm font-semibold text-foreground">No architecture to draw yet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Run an observed agent and SwarmTrace will build this from span kinds and parent links.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: 'Spans', value: traces.length.toLocaleString() },
          { label: 'Root runs', value: summary.roots.length.toLocaleString() },
          { label: 'Linked spans', value: summary.linked.toLocaleString() },
          { label: 'Tokens', value: summary.totalTokens.toLocaleString() },
          { label: 'Cost', value: formatCost(summary.totalCost) },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {item.label}
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-foreground">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Execution Architecture</h3>
            <p className="text-xs text-muted-foreground">
              Built from canonical span kinds, parent IDs, and trace context.
            </p>
          </div>
          <div className="flex gap-2 text-[10px] font-semibold uppercase tracking-wider">
            {summary.totalErrors > 0 && <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400">{summary.totalErrors} errors</span>}
            {summary.orphaned > 0 && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-400">{summary.orphaned} orphaned</span>}
          </div>
        </div>

        <div className="grid gap-3 p-4 xl:grid-cols-5">
          {layers.map((layer, index) => (
            <div key={layer.kind} className="relative">
              {index > 0 && (
                <div className="absolute -left-2 top-10 hidden h-px w-4 bg-border xl:block" />
              )}
              <div className="h-full rounded-xl border border-border bg-background/60 p-3">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-foreground">{layer.label}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{layer.description}</div>
                  </div>
                  <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {layer.spans}
                  </span>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2 text-[10px]">
                  <div className="rounded-lg bg-muted/30 p-2">
                    <div className="text-muted-foreground">Latency</div>
                    <div className="font-mono font-semibold text-foreground">{formatLatency(layer.latency)}</div>
                  </div>
                  <div className="rounded-lg bg-muted/30 p-2">
                    <div className="text-muted-foreground">Cost</div>
                    <div className="font-mono font-semibold text-foreground">{formatCost(layer.cost)}</div>
                  </div>
                </div>

                <div className="space-y-2">
                  {layer.components.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                      No {layer.label.toLowerCase()} spans
                    </div>
                  ) : (
                    layer.components.map((component) => {
                      const active = selected?.id === component.representative.id
                      return (
                        <button
                          key={component.name}
                          onClick={() => onSelect(component.representative)}
                          className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                            active
                              ? 'border-primary bg-primary/[0.06]'
                              : 'border-border bg-card hover:bg-muted/50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium text-foreground">{component.name}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">{component.calls}×</span>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                            <span>{formatLatency(component.latency)}</span>
                            <span>{component.tokens.toLocaleString()} tok</span>
                            <span>{formatCost(component.cost)}</span>
                          </div>
                          {component.errors > 0 && (
                            <div className="mt-1 text-[10px] font-semibold text-red-600 dark:text-red-400">
                              {component.errors} error{component.errors > 1 ? 's' : ''}
                            </div>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Observed span flows</h3>
            <p className="text-xs text-muted-foreground">Parent → child relationships by kind.</p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {edges.length} flow{edges.length === 1 ? '' : 's'}
          </span>
        </div>
        {edges.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No parent/child links in the current filter. Root spans still show as architecture layers above.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {edges.map((edge) => (
              <div key={`${edge.from}-${edge.to}`} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <span>{KIND_LABELS[edge.from].label}</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span>{KIND_LABELS[edge.to].label}</span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {edge.count} link{edge.count === 1 ? '' : 's'}
                  {edge.errors > 0 ? ` · ${edge.errors} error${edge.errors > 1 ? 's' : ''}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
