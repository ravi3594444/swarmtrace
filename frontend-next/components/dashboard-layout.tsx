'use client'

import { Sidebar } from './sidebar'
import { RealtimeProvider } from '@/contexts/RealtimeContext'
import { DashboardErrorBoundary } from './dashboard-error-boundary'
import { CommandPalette } from './command-palette'
import { KeyboardShortcutHelp } from './keyboard-shortcut-help'

// The onboarding tour provider lives in app/layout.tsx, not here.
export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <div className="flex h-screen bg-background transition-colors duration-200 lg:p-3 lg:gap-3">
        <CommandPalette />
        <KeyboardShortcutHelp />
        <Sidebar />
        {/* pt-12 clears the fixed mobile top bar; none on desktop */}
        <main id="main-content" className="flex-1 overflow-auto pt-12 lg:pt-0" tabIndex={-1}>
          {/* Skip link, visible on focus only */}
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
