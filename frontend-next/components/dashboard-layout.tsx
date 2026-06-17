import { Sidebar } from './sidebar'
import { RealtimeProvider } from '@/contexts/RealtimeContext'

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RealtimeProvider>
      <div className="flex h-screen bg-background">
        <Sidebar />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </RealtimeProvider>
  )
}
