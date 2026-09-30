import { DashboardLayout } from '@/components/dashboard-layout'

// Route group layout: keeps the shell (sidebar, realtime connection)
// mounted while navigating between dashboard pages.
export default function DashboardGroupLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardLayout>{children}</DashboardLayout>
}
