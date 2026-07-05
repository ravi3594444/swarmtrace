'use client'

import { Sidebar } from './sidebar'
import { RealtimeProvider } from '@/contexts/RealtimeContext'
import { DashboardErrorBoundary } from './dashboard-error-boundary'

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <div className="flex h-screen bg-background">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <DashboardErrorBoundary>
            {children}
          </DashboardErrorBoundary>
        </main>
      </div>
    </RealtimeProvider>
  )
}
