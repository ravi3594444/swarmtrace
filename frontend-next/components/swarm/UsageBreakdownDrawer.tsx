'use client'

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { fetchMetrics } from "@/lib/api";
import { useFocusTrap } from "@/lib/use-focus-trap";

// ── Types (mirrors the /api/metrics response shape) ──────────────────────────
type MetricsTotals = { cost: number; tokens_in: number; tokens_out: number; traces: number }
type MetricsData = {
  today: MetricsTotals
  last_7_days: MetricsTotals
  this_month: MetricsTotals
  all_time: MetricsTotals
  chart: unknown[]
}

const EMPTY: MetricsTotals = { cost: 0, tokens_in: 0, tokens_out: 0, traces: 0 }

// ── PeriodBlock — one row per time period ────────────────────────────────────
// Headline = total tokens (in + out). Substats show the breakdown:
// Input, Output, Cost, Traces — so the user sees the full picture per period
// without having to navigate to the Metrics page.
function PeriodBlock({
  label, data, highlight = false,
}: {
  label: string
  data: MetricsTotals
  highlight?: boolean
}) {
  const tokens = data.tokens_in + data.tokens_out
  return (
    <div
      className={
        "rounded-xl border p-4 transition-colors " +
        (highlight
          ? "border-primary/30 bg-primary/[0.03]"
          : "border-border bg-card hover:border-zinc-300")
      }
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums text-foreground leading-none tracking-tight">
        {tokens.toLocaleString()}
        <span className="ml-1.5 text-sm font-medium text-muted-foreground">tokens</span>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SubStat label="Input"  value={data.tokens_in.toLocaleString()} />
        <SubStat label="Output" value={data.tokens_out.toLocaleString()} />
        <SubStat label="Cost"   value={`$${data.cost.toFixed(3)}`} />
        <SubStat label="Traces" value={data.traces.toLocaleString()} />
      </div>
    </div>
  )
}

function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="text-sm font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  )
}

// ── Skeleton — shown while fetching ──────────────────────────────────────────
function PeriodSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="h-3 w-20 bg-muted rounded mb-3 animate-pulse" />
      <div className="h-7 w-32 bg-muted rounded animate-pulse" />
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="h-2.5 w-10 bg-muted rounded mb-1 animate-pulse" />
            <div className="h-4 w-12 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Drawer ───────────────────────────────────────────────────────────────────
export function UsageBreakdownDrawer({ open, onClose }: {
  open: boolean
  onClose: () => void
}) {
  const [data, setData] = useState<MetricsData | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  useFocusTrap(drawerRef, open)

  // Fetch metrics when the drawer opens (not on every render). Cached in
  // state so re-opening is instant unless the component unmounts.
  // All setState calls are inside the async .then() callback — never
  // synchronous in the effect body — to avoid cascading renders.
  useEffect(() => {
    if (!open) return
    // If we already have data (or already failed), don't re-fetch.
    if (data || fetchFailed) return
    let cancelled = false
    fetchMetrics().then((d) => {
      if (cancelled) return
      if (d) setData(d)
      else setFetchFailed(true)
    })
    return () => { cancelled = true }
  }, [open, data, fetchFailed])

  // Derived loading state — true while the first fetch is in flight.
  const loading = open && !data && !fetchFailed

  // ESC to close (matches DetailDrawer pattern)
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [open, onClose])

  // Lock body scroll while open — matches DetailDrawer. Previously this
  // drawer was missing the scroll lock, so the background page could scroll
  // behind it (inconsistent with DetailDrawer and jarring on long lists).
  useEffect(() => {
    if (!open) return
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = "" }
  }, [open])

  if (!open) return null

  const periods = data
    ? [
        { label: "Today",      data: data.today       ?? EMPTY },
        { label: "This Week",  data: data.last_7_days ?? EMPTY },
        { label: "This Month", data: data.this_month  ?? EMPTY },
        { label: "All Time",   data: data.all_time    ?? EMPTY, highlight: true },
      ]
    : []

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/10 backdrop-blur-sm fade-in"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Usage breakdown"
        className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-border bg-card fade-slide-in"
      >
        {/* Header */}
        <header className="flex items-start justify-between border-b border-border px-5 py-4 bg-muted/20">
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">Usage Breakdown</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Token usage &amp; spend across time periods
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors ml-3 shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading ? (
            <>
              <PeriodSkeleton />
              <PeriodSkeleton />
              <PeriodSkeleton />
              <PeriodSkeleton />
            </>
          ) : periods.length > 0 ? (
            periods.map((p) => (
              <PeriodBlock key={p.label} label={p.label} data={p.data} highlight={p.highlight} />
            ))
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Couldn&apos;t load metrics. Try again later.
            </div>
          )}

          {/* Footer hint */}
          {periods.length > 0 && (
            <div className="pt-2 text-center text-[11px] text-muted-foreground">
              See <span className="font-medium text-foreground">Metrics</span> page for daily charts
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
