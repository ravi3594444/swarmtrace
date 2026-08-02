'use client'

import { useRef, useState } from 'react'
import { ChevronDown, Download, FileJson, FileText } from 'lucide-react'
import type { Trace } from '@/lib/trace-types'
import { tracesToCsv, downloadCsv, downloadJson } from '@/lib/csv-export'
import { useDismissibleDropdown } from '@/hooks/use-dismissible-dropdown'

/**
 * Export dropdown (JSON / CSV) for a trace list. Previously duplicated
 * verbatim in app/overview/page.tsx and app/traces/page.tsx (only the
 * exported filename prefix differed) — extracted here as one shared,
 * accessible implementation.
 */
export function ExportMenu({
  traces,
  filenamePrefix = 'swarmtrace-export',
}: {
  traces: Trace[]
  /** Prefix for the downloaded filename, e.g. `${filenamePrefix}-2026-08-01.csv`. */
  filenamePrefix?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hasTraces = traces.length > 0

  useDismissibleDropdown(open, () => setOpen(false), wrapRef)

  const exportJSON = () => {
    // Guard against empty data — without this, the user could download a
    // file containing just "[]" (no traces). The menu button is also
    // disabled when there's no data, but this is belt-and-suspenders.
    if (traces.length === 0) return
    downloadJson(JSON.stringify(traces, null, 2), `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.json`)
  }

  const exportCSV = () => {
    if (traces.length === 0) return
    // tracesToCsv() in lib/csv-export.ts sanitizes every cell against
    // formula injection (=, +, -, @, tab, CR prefixes) — see the audit
    // finding documented there.
    const csv = tracesToCsv(traces)
    downloadCsv(csv, `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasTraces}
        aria-haspopup="menu"
        aria-expanded={open}
        title={hasTraces ? 'Export traces' : 'No traces to export yet'}
        className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"
      >
        <Download className="w-3.5 h-3.5" />
        Export
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && hasTraces && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-40 rounded-xl border border-border bg-card shadow-lg overflow-hidden">
          <button
            type="button"
            role="menuitem"
            onClick={() => { exportJSON(); setOpen(false) }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
          >
            <FileJson className="w-3.5 h-3.5 text-primary" /> Export JSON
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { exportCSV(); setOpen(false) }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
          >
            <FileText className="w-3.5 h-3.5 text-primary" /> Export CSV
          </button>
        </div>
      )}
    </div>
  )
}
