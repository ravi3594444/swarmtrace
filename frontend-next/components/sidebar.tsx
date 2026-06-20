'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  LayoutGrid, Users, ActivitySquare, BarChart3, Settings,
  Zap, AlertTriangle, ChevronRight, Menu, X,
} from 'lucide-react'
import { useUser, UserButton } from '@clerk/nextjs'

const navItems = [
  { href: '/overview', label: 'Overview', icon: LayoutGrid },
  { href: '/agents',   label: 'Agents',   icon: Users },
  { href: '/traces',   label: 'Traces',   icon: ActivitySquare },
  { href: '/metrics',  label: 'Metrics',  icon: BarChart3 },
  { href: '/failures', label: 'Failures', icon: AlertTriangle },
  { href: '/settings', label: 'Settings', icon: Settings },
]

function NavItem({
  href, label, icon: Icon, collapsed,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  collapsed: boolean
}) {
  const pathname = usePathname()
  const isActive = pathname === href

  return (
    <Link href={href}>
      <div
        title={collapsed ? label : undefined}
        className={`
          group relative flex items-center gap-3 rounded-lg text-sm font-medium
          transition-all duration-150 cursor-pointer
          ${collapsed ? 'justify-center px-0 py-2.5 w-10 mx-auto' : 'px-3 py-2.5 w-full'}
          ${isActive
            ? 'text-primary'
            : 'text-sidebar-foreground hover:bg-sidebar-border/60 hover:text-foreground'}
        `}
        style={isActive ? { background: 'color-mix(in oklch, var(--primary) 8%, transparent)', borderRadius: 8 } : {}}
      >
        <Icon
          className={`shrink-0 transition-colors ${collapsed ? 'w-5 h-5' : 'w-[17px] h-[17px]'} ${isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`}
          strokeWidth={isActive ? 2.2 : 1.7}
        />
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto text-primary/50" />}

        {collapsed && (
          <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {label}
          </span>
        )}
      </div>
    </Link>
  )
}

export function Sidebar() {
  const [open, setOpen] = useState(true)
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? 'Account'
  const initials = (user?.fullName ?? email).slice(0, 2).toUpperCase()

  return (
    <aside
      className="shrink-0 flex flex-col h-screen sticky top-0 bg-sidebar border-r border-sidebar-border transition-all duration-200 ease-in-out overflow-hidden"
      style={{ width: open ? 224 : 56 }}
    >
      {/* Logo + toggle */}
      <div className={`flex items-center border-b border-sidebar-border ${open ? 'px-4 py-4 gap-2.5 justify-between' : 'px-0 py-4 justify-center'}`}>
        {open && (
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
              <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold tracking-tight text-foreground leading-none">
                Swarm<span className="text-primary">Trace</span>
              </div>
            </div>
          </div>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 ${!open ? 'mx-auto' : ''}`}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {open ? <X className="w-3.5 h-3.5" /> : <Menu className="w-4 h-4" />}
        </button>
      </div>

      {!open && (
        <div className="flex justify-center py-2 border-b border-sidebar-border">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shadow-sm">
            <Zap className="w-4 h-4 text-white" strokeWidth={2.5} />
          </div>
        </div>
      )}

      <nav className={`flex-1 overflow-y-auto overflow-x-hidden py-3 ${open ? 'px-3 space-y-0.5' : 'px-0 space-y-1 flex flex-col items-center'}`}>
        {navItems.map((item) => (
          <NavItem key={item.href} {...item} collapsed={!open} />
        ))}
      </nav>

      {/* User footer */}
      {open ? (
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg bg-muted/60">
            <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7 shrink-0' } }} />
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground truncate">{email}</div>
              <div className="text-[10px] text-muted-foreground">{initials}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3 border-t border-sidebar-border flex justify-center">
          <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7 shrink-0' } }} />
        </div>
      )}
    </aside>
  )
}
