'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Calendar, ChevronDown, Check } from 'lucide-react'
import { TIME_RANGES, type TimeRangeKey } from '@/lib/trace-utils'

const STORAGE_KEY = 'swarmtrace:overview-time-range'

function isTimeRangeKey(v: string | null): v is TimeRangeKey {
  return v === 'today' || v === 'week' || v === 'month' || v === 'all'
}

// ── useSyncExternalStore plumbing ──────────────────────────────────────────
//
// We persist the user's time-range choice to localStorage so a page refresh
// doesn't snap back to "Today". The React-blessed way to read from an
// external store like localStorage is useSyncExternalStore: it returns the
// server snapshot during SSR (the default "today") and the client snapshot
// (the stored value) during hydration, with React reconciling the two —
// no setState-in-effect, no hydration mismatch warning.

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', callback)
  // `storage` only fires for *other* tabs; dispatch a custom event on this
  // tab so the hook re-reads after we write to localStorage here.
  window.addEventListener('swarmtrace:time-range-change', callback)
  return () => {
    window.removeEventListener('storage', callback)
    window.removeEventListener('swarmtrace:time-range-change', callback)
  }
}

function getClientSnapshot(): TimeRangeKey {
  const v = window.localStorage.getItem(STORAGE_KEY)
  return isTimeRangeKey(v) ? v : 'today'
}

function getServerSnapshot(): TimeRangeKey {
  return 'today'
}

/** Persist the user's time-range choice across page reloads. Defaults to
 *  "today" so the dashboard shows current activity on first visit — old
 *  data doesn't clutter the view. Users can switch to "All Time" and the
 *  choice persists. SSR-safe via useSyncExternalStore. */
export function useTimeRange() {
  const range = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)

  const setRange = (key: TimeRangeKey) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, key)
    // Notify this tab's subscribers — the native `storage` event only fires
    // in OTHER tabs, so we dispatch a same-tab event ourselves.
    window.dispatchEvent(new Event('swarmtrace:time-range-change'))
  }

  return { range, setRange }
}

// ── Dropdown component ─────────────────────────────────────────────────────

/**
 * Unified time-range picker. Used by most dashboard pages (Overview, Agents,
 * Network, Threads, Metrics) with just the 4 presets. The traces page passes
 * `enableCustomRange` to also show a custom from/to date picker — previously
 * the traces page had its own separate DateRangePicker component with a
 * different preset set and different styling. Now both use this one
 * component, so the preset list and visual treatment stay in sync.
 */
export function TimeRangeDropdown({
  value,
  onChange,
  enableCustomRange = false,
  fromDate,
  toDate,
  onFromDate,
  onToDate,
}: {
  value: TimeRangeKey
  onChange: (key: TimeRangeKey) => void
  /** When true, shows a "Custom range" section with from/to date inputs
   *  at the bottom of the dropdown. Used by the traces page. */
  enableCustomRange?: boolean
  /** Custom range start (yyyy-mm-dd). Only used when enableCustomRange is true. */
  fromDate?: string
  /** Custom range end (yyyy-mm-dd). Only used when enableCustomRange is true. */
  toDate?: string
  /** Callback for custom range start changes. */
  onFromDate?: (v: string) => void
  /** Callback for custom range end changes. */
  onToDate?: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [customActive, setCustomActive] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const current = TIME_RANGES.find((r) => r.key === value) ?? TIME_RANGES[0]

  // Close on outside click / Escape so the menu doesn't get stranded open.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const select = (key: TimeRangeKey) => {
    setCustomActive(false)
    onChange(key)
    setOpen(false)
  }

  const triggerLabel = customActive && fromDate && toDate
    ? `${fromDate.slice(5).replace('-', '/')} – ${toDate.slice(5).replace('-', '/')}`
    : customActive && fromDate
      ? `From ${fromDate.slice(5).replace('-', '/')}`
      : customActive && toDate
        ? `Until ${toDate.slice(5).replace('-', '/')}`
        : current.short

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Filter dashboard by time range"
        className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-zinc-300 transition-colors"
      >
        <Calendar className="w-3.5 h-3.5" />
        {triggerLabel}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1 z-40 w-44 rounded-xl border border-border bg-card overflow-hidden"
        >
          {TIME_RANGES.map((r) => {
            const active = !customActive && r.key === value
            return (
              <button
                key={r.key}
                role="option"
                aria-selected={active}
                type="button"
                onClick={() => select(r.key)}
                className={`flex items-center gap-2 w-full px-3 py-2 text-left text-xs transition-colors hover:bg-muted/60
                  ${active ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
              >
                <span className="flex-1">{r.label}</span>
                {active && <Check className="w-3.5 h-3.5 text-primary" />}
              </button>
            )
          })}

          {/* Custom range — only shown when enableCustomRange is true.
              This is the feature the traces page needs that other pages
              don't. Keeping it in the same component means the preset
              list + styling stay consistent across the app. */}
          {enableCustomRange && (
            <div className="border-t border-border px-3 py-2.5">
              <div className={`text-[11px] mb-1.5 ${customActive ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                Custom range
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="date" value={fromDate ?? ''} max={toDate || undefined}
                  onChange={(e) => { setCustomActive(true); onFromDate?.(e.target.value) }}
                  aria-label="From date"
                  className="min-w-0 flex-1 bg-muted/40 rounded-md px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-muted-foreground/60 text-xs">–</span>
                <input
                  type="date" value={toDate ?? ''} min={fromDate || undefined}
                  onChange={(e) => { setCustomActive(true); onToDate?.(e.target.value) }}
                  aria-label="To date"
                  className="min-w-0 flex-1 bg-muted/40 rounded-md px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
