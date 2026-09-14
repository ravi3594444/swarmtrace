import { DashboardLayout } from '@/components/dashboard-layout'

/**
 * Shared chrome for every dashboard route.
 *
 * This is a route group — the "(dashboard)" segment does not appear in any
 * URL, so /overview, /traces and the rest are unchanged. What it buys is a
 * layout that Next.js keeps mounted across navigations inside the group.
 *
 * Before this, each page rendered its own <DashboardLayout>, so clicking a
 * nav item tore down and rebuilt the entire shell: the sidebar (losing its
 * scroll position and collapse state), the Clerk user button, the realtime
 * connection and the onboarding tour, twice over on pages that swap in a
 * loading skeleton. That teardown is what made moving between pages feel
 * laggy and made the sidebar jump. Now only the page body swaps.
 */
export default function DashboardGroupLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardLayout>{children}</DashboardLayout>
}
