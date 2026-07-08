'use client'

import { Sidebar } from './sidebar'
import { RealtimeProvider } from '@/contexts/RealtimeContext'
import { DashboardErrorBoundary } from './dashboard-error-boundary'
import { CommandPalette } from './command-palette'
import { OnboardingTourProvider } from './onboarding/OnboardingTour'

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <OnboardingTourProvider>
        <div className="flex h-screen bg-background transition-colors duration-200">
          <CommandPalette />
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <DashboardErrorBoundary>
              {children}
            </DashboardErrorBoundary>
          </main>
        </div>
      </OnboardingTourProvider>
    </RealtimeProvider>
  )
}
