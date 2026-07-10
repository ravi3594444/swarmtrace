'use client'

import { DashboardLayout } from '@/components/dashboard-layout'
import { PageHeader } from '@/components/page-header'

/**
 * DashboardSkeleton — skeleton loading state for dashboard pages.
 *
 * Replaces the full-page SwarmLoadingScreen (Lottie animation) with a
 * skeleton layout that matches the page structure. This avoids a jarring
 * full-page spinner and instead shows the sidebar + header immediately,
 * with only the content area showing animated placeholders. The user
 * sees the page "taking shape" rather than a blank screen with a spinner.
 *
 * The layout matches Overview (the most complex page) — other pages
 * (Traces, Agents, Metrics) will have fewer skeletons than they need,
 * but the header + sidebar render instantly and the content area is
 * visually occupied, which is the main goal.
 */
export function DashboardSkeleton({ title = 'Loading…', description = 'Loading…' }: { title?: string; description?: string }) {
  return (
    <DashboardLayout>
      <PageHeader
        title={title}
        description={description ?? 'Loading…'}
        actions={
          <div className="flex items-center gap-2">
            {/* Skeleton for TimeRangeDropdown */}
            <div className="h-8 w-24 rounded-lg border border-border bg-card animate-pulse" />
            {/* Skeleton for export/menu */}
            <div className="h-8 w-8 rounded-lg border border-border bg-card animate-pulse" />
          </div>
        }
      />
      <div className="p-6 space-y-6">
        {/* Skeleton for stat bar (4 stat cards) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-5 shadow-sm animate-pulse">
              <div className="h-3 bg-muted rounded w-16 mb-3" />
              <div className="h-8 bg-muted rounded w-20 mb-2" />
              <div className="h-3 bg-muted rounded w-24" />
            </div>
          ))}
        </div>

        {/* Skeleton for main chart + side panel */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 rounded-xl border border-border bg-card shadow-sm overflow-hidden animate-pulse">
            <div className="h-12 border-b border-border bg-muted/30" />
            <div className="p-4 h-44">
              <div className="h-full bg-muted/40 rounded" />
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden animate-pulse">
            <div className="h-12 border-b border-border bg-muted/30" />
            <div className="p-4 space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-4 bg-muted rounded w-full" />
              ))}
            </div>
          </div>
        </div>

        {/* Skeleton for bottom panels */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden animate-pulse">
              <div className="h-12 border-b border-border bg-muted/30" />
              <div className="p-4 space-y-3">
                {[0, 1, 2, 3].map((j) => (
                  <div key={j} className="h-4 bg-muted rounded w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
