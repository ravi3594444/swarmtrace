'use client'

import { Sidebar } from './sidebar'
import { RealtimeProvider } from '@/contexts/RealtimeContext'
import { DashboardErrorBoundary } from './dashboard-error-boundary'
import { CommandPalette } from './command-palette'
import { KeyboardShortcutHelp } from './keyboard-shortcut-help'

// NOTE: the onboarding tour provider is deliberately NOT mounted here. This
// component is mounted (and remounted) by every dashboard page, so a provider
// inside it is destroyed and recreated on each navigation — which made the
// tour overlay flicker and replay steps. It lives in app/layout.tsx instead.
export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <div className="flex h-screen bg-background transition-colors duration-200 lg:p-3 lg:gap-3">
        <CommandPalette />
        <KeyboardShortcutHelp />
        <Sidebar />
        {/* pt-12 lg:pt-0 — the mobile top bar (h-12) is fixed, so the
            main content needs top padding on mobile to not sit under it.
            On desktop (lg+) there's no top bar, so no padding. */}
        <main id="main-content" className="flex-1 overflow-auto pt-12 lg:pt-0" tabIndex={-1}>
          {/* Skip-to-content link — visible on focus only. Lets keyboard
              users skip the 8-item sidebar nav on every page. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:text-sm focus:font-medium focus:shadow-lg"
          >
            Skip to content
          </a>
          <DashboardErrorBoundary>
            {children}
          </DashboardErrorBoundary>
        </main>
      </div>
    </RealtimeProvider>
  )
}
