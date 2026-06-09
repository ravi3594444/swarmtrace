'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Users, ActivitySquare, BarChart3, Settings } from 'lucide-react'
import { UserButton, useUser } from '@clerk/nextjs'

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutGrid },
  { href: '/agents', label: 'Agents', icon: Users },
  { href: '/traces', label: 'Traces', icon: ActivitySquare },
  { href: '/metrics', label: 'Metrics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const { user } = useUser()

  return (
    <aside className="w-56 bg-sidebar border-r border-sidebar-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
            <div className="w-6 h-6 rounded-full border-2 border-sidebar" />
          </div>
          <div>
            <h1 className="font-bold text-primary text-sm">SwarmTrace</h1>
            <p className="text-xs text-muted-foreground">AI Monitoring</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-6 space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-full transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-sm font-medium">{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Upgrade button */}
      <div className="p-6 border-t border-sidebar-border">
        <button className="w-full px-4 py-3 rounded-full bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity">
          Upgrade Plan
        </button>
      </div>

      {/* Auth Profile Section */}
      <div className="px-6 pb-6 pt-4 border-t border-sidebar-border flex items-center gap-3">
        <UserButton afterSignOutUrl="/sign-in" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">
            {user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Admin User'}
          </p>
          <p className="text-[10px] text-muted-foreground">Pro Tier</p>
        </div>
      </div>
    </aside>
  )
}
