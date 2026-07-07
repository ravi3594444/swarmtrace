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
  return isTimeRangeKey(v) ? v : 'all'
}

function getServerSnapshot(): TimeRangeKey {
  return 'all'
}

/** Persist the user's time-range choice across page reloads. Defaults to
 *  "all" when no preference is stored so the dashboard never looks empty
 *  when data exists outside today. SSR-safe via useSyncExternalStore. */
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

export function TimeRangeDropdown({
  value,
  onChange,
}: {
  value: TimeRangeKey
  onChange: (key: TimeRangeKey) => void
}) {
  const [open, setOpen] = useState(false)
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
    onChange(key)
    setOpen(false)
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Filter dashboard by time range"
        className="flex items-center gap-1.5 h-8 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-zinc-300 transition-colors shadow-sm"
      >
        <Calendar className="w-3.5 h-3.5" />
        {current.short}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1 z-40 w-44 rounded-xl border border-border bg-card shadow-lg overflow-hidden"
        >
          {TIME_RANGES.map((r) => {
            const active = r.key === value
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
        </div>
      )}
    </div>
  )
}
