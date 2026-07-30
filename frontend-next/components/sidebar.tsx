'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import {
  LayoutGrid, Users, ActivitySquare, BarChart3, Settings,
  Zap, AlertTriangle, ChevronRight, Menu, X, LogOut,
  MessagesSquare, GitCompareArrows, Compass, GitBranch,
  HelpCircle, Sparkles, Plus, Search,
} from 'lucide-react'
import { useUser, UserButton, SignOutButton } from '@clerk/nextjs'
import { useOnboardingTour } from './onboarding/OnboardingTour'
import { useFocusTrap } from '@/lib/use-focus-trap'

/** "Take a tour" trigger — replays the new-user onboarding tour on demand. */
function TakeTourButton({ collapsed }: { collapsed: boolean }) {
  const { startTour } = useOnboardingTour()
  return (
    <button
      type="button"
      onClick={startTour}
      title="Take a tour"
      aria-label="Take a tour"
      className={`group flex items-center gap-3 rounded-full text-sm font-medium transition-colors duration-150
        ${collapsed
          ? 'justify-center px-0 py-2.5 w-10 mx-auto text-sidebar-foreground/60 hover:bg-sidebar-accent'
          : 'px-3 py-2.5 w-full text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}
    >
      <Compass
        className={`shrink-0 ${collapsed ? 'w-[18px] h-[18px]' : 'w-[18px] h-[18px]'}`}
        strokeWidth={1.7}
      />
      {!collapsed && <span className="truncate">Take a tour</span>}
    </button>
  )
}

const navGroups = [
  {
    label: 'Workspace',
    items: [
      { href: '/overview', label: 'Dashboard', icon: LayoutGrid },
      { href: '/agents',   label: 'Agents',   icon: Users, chevron: true },
      { href: '/traces',   label: 'Traces',   icon: ActivitySquare, chevron: true },
      { href: '/threads',  label: 'Threads',  icon: MessagesSquare, chevron: true },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { href: '/network',  label: 'Network',  icon: GitBranch },
      { href: '/metrics',  label: 'Metrics',  icon: BarChart3 },
      { href: '/compare',  label: 'Compare',  icon: GitCompareArrows },
      { href: '/failures', label: 'Failures', icon: AlertTriangle },
    ],
  },
]

function NavItem({
  href, label, icon: Icon, collapsed, onNavigate, chevron, disabled,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  collapsed: boolean
  onNavigate?: () => void
  chevron?: boolean
  disabled?: boolean
}) {
  const pathname = usePathname()
  const isActive = pathname === href
    || pathname.startsWith(href + '/')
    || pathname.startsWith(href + '?')

  const Wrapper: React.ElementType = disabled ? 'div' : Link
  const wrapperProps = disabled ? {} : { href, onClick: onNavigate }

  return (
    <Wrapper {...wrapperProps}>
      <div
        data-tour={`nav-${label.toLowerCase()}`}
        title={collapsed ? label : undefined}
        className={`
          group relative flex items-center gap-3 text-sm font-medium
          transition-all duration-150 cursor-pointer select-none
          ${collapsed
            ? 'justify-center px-0 py-2.5 w-10 mx-auto rounded-full'
            : 'px-3.5 py-2.5 w-full rounded-full'}
          ${isActive
            ? 'bg-[color:var(--sidebar-active)] text-[color:var(--sidebar-active-foreground)] shadow-sm'
            : disabled
              ? 'text-sidebar-foreground/40 cursor-not-allowed'
              : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'}
        `}
      >
        <Icon
          className={`shrink-0 w-[18px] h-[18px] ${
            isActive
              ? 'text-[color:var(--sidebar-active-foreground)]'
              : 'text-sidebar-foreground/55 group-hover:text-sidebar-foreground'
          }`}
          strokeWidth={isActive ? 2.1 : 1.7}
        />
        {!collapsed && (
          <>
            <span className="truncate">{label}</span>
            {chevron && !isActive && (
              <ChevronRight className="w-3.5 h-3.5 ml-auto text-sidebar-foreground/40" />
            )}
          </>
        )}

        {collapsed && (
          <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 text-xs font-medium text-sidebar-foreground shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {label}
          </span>
        )}
      </div>
    </Wrapper>
  )
}

/** Logout button with a confirm modal (same UX as before, restyled to match). */
function LogoutButton() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, confirmOpen)

  useEffect(() => {
    if (!confirmOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmOpen])

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        title="Log out"
        aria-label="Log out"
        aria-haspopup="dialog"
        aria-expanded={confirmOpen}
        className="w-7 h-7 rounded-full flex items-center justify-center text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-red-500 transition-colors shrink-0"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm log out"
            onClick={(e) => e.stopPropagation()}
            className="w-64 rounded-2xl border border-sidebar-border bg-card overflow-hidden shadow-2xl"
          >
            <div className="px-4 py-4 border-b border-border bg-muted/30">
              <p className="text-sm font-semibold text-foreground text-center">Log out?</p>
              <p className="text-xs text-muted-foreground text-center mt-0.5">
                You&apos;ll need to sign in again.
              </p>
            </div>
            <div className="p-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-9 rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <SignOutButton redirectUrl="/sign-in">
                <button
                  type="button"
                  className="w-full h-9 rounded-full bg-[color:var(--sidebar-active)] text-xs font-semibold text-[color:var(--sidebar-active-foreground)] hover:opacity-90 transition-opacity"
                >
                  Log out
                </button>
              </SignOutButton>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * IconRail — the narrow dark dock on the far left (matching the trypitch
 * sidebar's leftmost strip with app-switcher icons + a "+" button to
 * add new connections/workspaces).
 */
function IconRail({ onOpenSidebar }: { onOpenSidebar?: () => void }) {
  return (
    <div className="hidden lg:flex w-12 shrink-0 h-screen flex-col items-center py-3 gap-1.5 bg-[color:var(--sidebar-rail)] border-r border-[color:var(--sidebar-rail-border)] sticky top-0">
      {/* App/menu icon (top-left grid icon in trypitch) */}
      <button
        type="button"
        onClick={onOpenSidebar}
        title="Menu"
        aria-label="Toggle menu"
        className="w-9 h-9 rounded-lg flex items-center justify-center text-[color:var(--sidebar-rail-foreground)] hover:bg-[color:var(--sidebar-rail-accent)] hover:text-[color:var(--sidebar-rail-accent-foreground)] transition-colors"
      >
        <Menu className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </button>

      <div className="w-6 h-px bg-[color:var(--sidebar-rail-border)] my-1" />

      {/* Search / EQ-style icon (second icon in the rail) */}
      <button
        type="button"
        title="Search"
        aria-label="Search"
        className="w-9 h-9 rounded-lg flex items-center justify-center text-[color:var(--sidebar-rail-foreground)]/70 hover:bg-[color:var(--sidebar-rail-accent)] hover:text-[color:var(--sidebar-rail-accent-foreground)] transition-colors"
      >
        <Search className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </button>

      {/* Quick-add buttons (the star / instagram-style icons in trypitch rail) */}
      <button
        type="button"
        title="Quick actions"
        className="w-9 h-9 rounded-lg flex items-center justify-center text-orange-400 hover:bg-[color:var(--sidebar-rail-accent)] transition-colors"
      >
        <Sparkles className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </button>

      <div className="flex-1" />

      {/* + New button at bottom of rail */}
      <button
        type="button"
        title="New"
        aria-label="New"
        className="w-9 h-9 rounded-lg flex items-center justify-center text-[color:var(--sidebar-rail-foreground)]/80 hover:bg-[color:var(--sidebar-rail-accent)] hover:text-[color:var(--sidebar-rail-accent-foreground)] transition-colors border border-[color:var(--sidebar-rail-border)]"
      >
        <Plus className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </button>
    </div>
  )
}

export function Sidebar() {
  const [open, setOpen] = useState(true)            // desktop collapse state
  const [mobileOpen, setMobileOpen] = useState(false) // mobile drawer state
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? 'Account'
  const initials = (user?.fullName ?? email).slice(0, 2).toUpperCase()

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return (
    <>
      {/* ── Mobile top bar (lg:hidden) ─────────────────────────────── */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-30 h-14 flex items-center justify-between px-4 bg-sidebar border-b border-sidebar-border">
        <button
          onClick={() => setMobileOpen(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[color:var(--sidebar-active)] flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-[color:var(--sidebar-active-foreground)]" strokeWidth={2.5} />
          </div>
          <span className="text-sm font-bold tracking-tight text-sidebar-foreground">
            Swarm<span className="text-sidebar-foreground/60">Trace</span>
          </span>
        </div>
        <UserButton appearance={{ elements: { avatarBox: 'w-8 h-8' } }} />
      </div>

      {/* ── Mobile backdrop ────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Desktop: dark icon rail ────────────────────────────────── */}
      <IconRail onOpenSidebar={() => setOpen(true)} />

      {/* ── Desktop: collapsed-state "peek" handle when panel is closed */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="hidden lg:flex w-8 shrink-0 h-screen items-center justify-center hover:bg-sidebar-accent/50 transition-colors group"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <ChevronRight className="w-4 h-4 text-sidebar-foreground/40 group-hover:text-sidebar-foreground transition-colors" />
        </button>
      )}

      {/* ── Sidebar panel (desktop persistent + mobile drawer) ─────── */}
      <aside
        className={`
          shrink-0 flex flex-col h-screen bg-sidebar
          transition-[width,transform] duration-200 ease-in-out overflow-hidden
          border-r border-sidebar-border
          fixed lg:sticky top-0 z-50 lg:z-auto
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
        style={{ width: open ? 240 : 0 }}
      >
        {/* Logo */}
        <div className="flex items-center px-5 pt-5 pb-4 gap-2.5 justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-[color:var(--sidebar-active)] flex items-center justify-center shrink-0 shadow-sm">
              <Zap className="w-[18px] h-[18px] text-[color:var(--sidebar-active-foreground)]" strokeWidth={2.5} />
            </div>
            <div className="min-w-0 leading-tight">
              <div className="text-base font-bold tracking-tight text-sidebar-foreground leading-none font-mono">
                SWARM<span className="opacity-60">TRACE</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              if (window.innerWidth < 1024) setMobileOpen(false)
              else setOpen(false)
            }}
            className="lg:flex w-7 h-7 rounded-full items-center justify-center text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors shrink-0"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Main nav */}
        <nav
          aria-label="Dashboard navigation"
          className="flex-1 overflow-y-auto overflow-x-hidden pt-2 pb-4 px-3 space-y-4"
        >
          {navGroups.map((group, gi) => (
            <div key={group.label} className="space-y-1">
              {group.items.map((item) => (
                <NavItem
                  key={item.href}
                  {...item}
                  collapsed={false}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
              {gi < navGroups.length - 1 && (
                <div className="mx-3.5 mt-3 border-t border-sidebar-border/70" />
              )}
            </div>
          ))}

          <div className="pt-2">
            <NavItem
              href="/settings"
              label="Settings"
              icon={Settings}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
            />
            <button
              type="button"
              className="flex items-center gap-3 px-3.5 py-2.5 w-full rounded-full text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
            >
              <HelpCircle className="shrink-0 w-[18px] h-[18px] text-sidebar-foreground/55" strokeWidth={1.7} />
              <span className="truncate">Support</span>
            </button>
          </div>

          <TakeTourButton collapsed={false} />
        </nav>

        {/* Footer: Upgrade CTA + user row */}
        <div className="px-3 pb-4 pt-2 border-t border-sidebar-border/70 space-y-3">
          {/* Upgrade Pro CTA — matches the dark pill in the screenshot */}
          <Link
            href="/contact"
            onClick={() => setMobileOpen(false)}
            className="group flex items-center gap-2.5 w-full px-4 py-2.5 rounded-full bg-[color:var(--sidebar-active)] text-[color:var(--sidebar-active-foreground)] hover:opacity-90 transition-opacity shadow-sm"
          >
            <Sparkles className="w-4 h-4" strokeWidth={2} />
            <span className="text-sm font-semibold flex-1">Upgrade Pro</span>
            <Zap className="w-4 h-4 opacity-80" strokeWidth={2} />
          </Link>

          {/* User row */}
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-full hover:bg-sidebar-accent transition-colors">
            <UserButton
              appearance={{
                elements: {
                  avatarBox: 'w-8 h-8 shrink-0 rounded-full ring-2 ring-sidebar-border',
                },
              }}
            />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-xs font-semibold text-sidebar-foreground truncate">{email}</div>
              <div className="text-[11px] text-sidebar-foreground/50 truncate">{initials} · Free</div>
            </div>
            <LogoutButton />
          </div>
        </div>
      </aside>
    </>
  )
}
