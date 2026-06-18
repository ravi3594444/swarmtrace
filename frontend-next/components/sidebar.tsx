'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutGrid, Users, ActivitySquare, BarChart3, Settings,
} from 'lucide-react'
import { UserButton } from '@clerk/nextjs'

const navItems = [
  { href: '/overview', label: 'Overview',  icon: LayoutGrid      },
  { href: '/agents',   label: 'Agents',    icon: Users           },
  { href: '/traces',   label: 'Traces',    icon: ActivitySquare  },
  { href: '/metrics',  label: 'Metrics',   icon: BarChart3       },
  { href: '/settings', label: 'Settings',  icon: Settings        },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="w-14 bg-[hsl(var(--sidebar))] border-r border-[hsl(var(--sidebar-border))] flex flex-col h-screen sticky top-0 items-center py-3 gap-1 shrink-0">
      {/* Logo mark */}
      <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center mb-3 shrink-0">
        <div className="w-4 h-4 rounded-full border-2 border-primary-foreground" />
      </div>

      {/* Nav icons */}
      <nav className="flex flex-col items-center gap-1 flex-1 w-full px-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              title={label}
              className={`
                group relative w-10 h-10 flex items-center justify-center rounded-lg transition-all
                ${isActive
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'}
              `}
            >
              <Icon className="w-[18px] h-[18px]" strokeWidth={isActive ? 2 : 1.5} />

              {/* Tooltip */}
              <span className="
                pointer-events-none absolute left-12 z-50 whitespace-nowrap
                rounded-md bg-popover text-popover-foreground border border-border
                px-2 py-1 text-xs font-medium shadow-md
                opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100
                transition-all duration-150 origin-left
              ">
                {label}
              </span>
            </Link>
          )
        })}
      </nav>

      {/* User avatar */}
      <div className="mt-auto pt-2 border-t border-[hsl(var(--sidebar-border))] w-full flex justify-center pt-3">
        <UserButton />
      </div>
    </aside>
  )
}
