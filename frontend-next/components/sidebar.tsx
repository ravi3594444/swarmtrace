'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Users, ActivitySquare, BarChart3, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutGrid },
  { href: '/agents', label: 'Agents', icon: Users },
  { href: '/traces', label: 'Traces', icon: ActivitySquare },
  { href: '/metrics', label: 'Metrics', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const [apiReachable, setApiReachable] = useState(false)

  useEffect(() => {
    let isMounted = true
    const checkApi = async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
        if (isMounted) setApiReachable(res.ok)
      } catch {
        if (isMounted) setApiReachable(false)
      }
    }
    checkApi()
    const interval = setInterval(checkApi, 30000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [])

  return (
    <aside className="w-56 bg-sidebar border-r border-sidebar-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
            <div className="w-6 h-6 rounded-full border-2 border-sidebar" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-primary text-sm">SwarmTrace</h1>
              <div className={`w-2 h-2 rounded-full ${apiReachable ? 'bg-green-500 animate-pulse' : 'bg-outline-variant'}`} />
            </div>
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

      {/* User info */}
      <div className="px-6 pb-6 border-t border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-secondary" />
          <div>
            <p className="text-xs font-semibold text-foreground">Admin User</p>
            <p className="text-xs text-muted-foreground">Pro Tier</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
