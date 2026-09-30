'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import {
  LayoutGrid, Users, ActivitySquare, BarChart3, Settings,
  Zap, AlertTriangle, ChevronRight, Menu, X, LogOut,
  MessagesSquare, GitCompareArrows, Compass, GitBranch, TrendingDown, Home,
  BookOpen,
} from 'lucide-react'
import { useUser, UserButton, SignOutButton } from '@clerk/nextjs'
import { useOnboardingTour } from './onboarding/OnboardingTour'
import { useFocusTrap } from '@/lib/use-focus-trap'
import { requestSetupGuide } from '@/components/first-run-empty-state'

// Row geometry shared by the nav links and the "Take a tour" button.
function rowClasses(collapsed: boolean): string {
  return `group relative flex items-center gap-3 rounded-xl text-sm font-medium ${
    collapsed ? 'justify-center px-0 py-2.5 w-10 mx-auto' : 'px-3 py-2.5 w-full'
  }`
}

const ROW_ICON = 'shrink-0 w-[18px] h-[18px]'

// Replays the onboarding tour on demand.
function TakeTourButton({
  collapsed,
  onStart,
}: {
  collapsed: boolean
  onStart?: () => void
}) {
  const { startTour } = useOnboardingTour()

  const handleStart = () => {
    onStart?.()
    startTour()
  }

  return (
    <button
      type="button"
      onClick={handleStart}
      title="Take a tour"
      aria-label="Take a tour"
      aria-haspopup="dialog"
      className={`${rowClasses(collapsed)} text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground active:bg-sidebar-accent`}
    >
      <Compass
        className={`${ROW_ICON} transition-colors text-sidebar-foreground/60 group-hover:text-sidebar-accent-foreground`}
        strokeWidth={1.7}
      />
      {!collapsed && <span className="truncate">Take a tour</span>}
    </button>
  )
}

// Desktop rail collapse state. The module-level cache survives remounts,
// localStorage survives reloads.
const SIDEBAR_OPEN_KEY = 'swarmtrace-sidebar-open'
let cachedSidebarOpen: boolean | null = null

function readStoredSidebarOpen(): boolean {
  if (cachedSidebarOpen !== null) return cachedSidebarOpen
  if (typeof window === 'undefined') return true
  try {
    cachedSidebarOpen = window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0'
  } catch {
    cachedSidebarOpen = true
  }
  return cachedSidebarOpen
}

function persistSidebarOpen(next: boolean): void {
  cachedSidebarOpen = next
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, next ? '1' : '0')
  } catch {
    // localStorage may be unavailable (private mode); the module cache still
    // keeps the rail steady for the rest of this session.
  }
}

/**
 * "Setup guide" trigger. The guide only auto-shows for accounts with no
 * traces yet, so this keeps the install steps reachable afterwards.
 */
function SetupGuideButton({
  collapsed,
  onOpen,
}: {
  collapsed: boolean
  onOpen?: () => void
}) {
  const router = useRouter()

  const handleOpen = () => {
    onOpen?.()
    requestSetupGuide()
    router.push('/overview')
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      title="Setup guide"
      aria-label="Setup guide"
      className={`${rowClasses(collapsed)} text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground active:bg-sidebar-accent`}
    >
      <BookOpen
        className={`${ROW_ICON} transition-colors text-sidebar-foreground/60 group-hover:text-sidebar-accent-foreground`}
        strokeWidth={1.7}
      />
      {!collapsed && <span className="truncate">Setup guide</span>}
    </button>
  )
}

const navGroups = [
  {
    label: 'Monitor',
    items: [
      // Home is the plain-English summary for non-technical users; the
      // pages below it remain the full developer views.
      { href: '/home',     label: 'Home',     icon: Home },
      { href: '/overview', label: 'Overview', icon: LayoutGrid },
      { href: '/agents',   label: 'Agents',   icon: Users },
      { href: '/network',  label: 'Network',  icon: GitBranch },
      { href: '/traces',   label: 'Traces',   icon: ActivitySquare },
      { href: '/threads',  label: 'Threads',  icon: MessagesSquare },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { href: '/metrics',  label: 'Metrics',  icon: BarChart3 },
      { href: '/compare',  label: 'Compare',  icon: GitCompareArrows },
      { href: '/regression', label: 'Regression', icon: TrendingDown },
      { href: '/failures', label: 'Failures', icon: AlertTriangle },
    ],
  },
  {
    label: 'Account',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

function NavItem({
  href, label, icon: Icon, collapsed, onNavigate,
}: {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  collapsed: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  // Sub-routes keep the parent highlighted. Require a separator after the
  // prefix so /over doesn't match /overview.
  const isActive = pathname === href
    || pathname.startsWith(href + '/')
    || pathname.startsWith(href + '?')

  return (
    <Link href={href} onClick={onNavigate}>
      <div
        data-tour={`nav-${label.toLowerCase()}`}
        title={collapsed ? label : undefined}
        className={`${rowClasses(collapsed)} transition-colors duration-150 cursor-pointer ${
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
        }`}
      >
        <Icon
          className={`${ROW_ICON} transition-colors ${isActive ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground/60 group-hover:text-sidebar-accent-foreground'}`}
          strokeWidth={isActive ? 2.2 : 1.7}
        />
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto text-sidebar-accent-foreground/60" />}

        {collapsed && (
          <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {label}
          </span>
        )}
      </div>
    </Link>
  )
}

/**
 * Logout button with a confirm modal. The modal is a fixed overlay rather
 * than a popover because the sidebar's <aside> is overflow-hidden and would
 * clip it. Backdrop click or Escape cancels; Clerk's <SignOutButton> wraps
 * the confirm button.
 */
function LogoutButton() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, confirmOpen)

  // Close on Escape so the modal doesn't get stranded.
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
        className="w-7 h-7 rounded-lg border border-sidebar-border bg-sidebar flex items-center justify-center text-sidebar-foreground/60 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 hover:border-red-500/30 dark:hover:border-red-900/60 transition-colors shrink-0"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>

      {confirmOpen && (
        // Backdrop click (not the card) closes without signing out.
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
            className="w-64 rounded-xl border border-border bg-card overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-border bg-muted/30">
              <p className="text-sm font-medium text-foreground text-center">Log out?</p>
              <p className="text-xs text-muted-foreground text-center mt-0.5">
                You&apos;ll need to sign in again.
              </p>
            </div>
            <div className="p-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-8 rounded-md border border-border bg-card text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <SignOutButton redirectUrl="/sign-in">
                <button
                  type="button"
                  className="w-full h-8 rounded-md bg-red-600 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
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

export function Sidebar() {
  // Starts open so SSR and client markup match; the stored value is applied
  // after hydration, and the module cache covers later remounts.
  const [open, setOpen] = useState(() => cachedSidebarOpen ?? true)
  const [mobileOpen, setMobileOpen] = useState(false) // mobile drawer state
  // Width animation stays off until the stored state has been applied, so a
  // collapsed rail never visibly animates open -> closed on a fresh load.
  const [animateWidth, setAnimateWidth] = useState(cachedSidebarOpen !== null)
  const drawerRef = useRef<HTMLElement>(null)
  const navRef = useRef<HTMLElement>(null)
  // The nav reserves a scrollbar gutter (see globals.css), so rows outside
  // it are wider. Measure the gutter and mirror it on the footer.
  const [navGutter, setNavGutter] = useState(0)
  // Keep Tab inside the drawer while it covers the page on mobile, and give
  // focus back to the hamburger when it closes.
  useFocusTrap(drawerRef, mobileOpen)
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? 'Account'
  const initials = (user?.fullName ?? email).slice(0, 2).toUpperCase()

  useEffect(() => {
    if (cachedSidebarOpen === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration localStorage read; runs once.
      setOpen(readStoredSidebarOpen())
    }
    const id = window.requestAnimationFrame(() => setAnimateWidth(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const el = navRef.current
    if (!el) return
    const measure = () => setNavGutter(el.offsetWidth - el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [open])

  const toggleOpen = () => {
    const next = !open
    persistSidebarOpen(next)
    setOpen(next)
  }

  // Close the mobile drawer on Escape (matches the logout modal pattern).
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  // Lock body scroll while the drawer is open; close it if the viewport
  // grows to desktop so the backdrop isn't left behind.
  useEffect(() => {
    if (!mobileOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => {
      if (mq.matches) setMobileOpen(false)
    }
    onChange()
    mq.addEventListener('change', onChange)
    return () => {
      document.body.style.overflow = previousOverflow
      mq.removeEventListener('change', onChange)
    }
  }, [mobileOpen])

  // The sidebar <aside> is shared between desktop (persistent) and mobile
  // (off-canvas drawer). On mobile it's translated off-screen by default
  // and slides in when mobileOpen is true. On desktop it's always visible
  // and the collapse toggle (open state) controls its width.
  return (
    <>
      {/* Mobile top bar with the hamburger */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-30 h-12 flex items-center justify-between px-4 bg-sidebar border-b border-sidebar-border">
        <button
          onClick={() => setMobileOpen(true)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-sidebar-primary flex items-center justify-center shrink-0">
            <Zap className="w-3.5 h-3.5 text-sidebar-primary-foreground" strokeWidth={2.5} />
          </div>
          <span className="text-sm font-bold tracking-tight text-sidebar-foreground">
            Swarm<span className="text-sidebar-primary">Trace</span>
          </span>
        </div>
        <div className="w-8" /> {/* spacer to center the logo */}
      </div>

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Desktop rail / mobile drawer */}
      <aside
        ref={drawerRef}
        className={`
          shrink-0 flex flex-col h-screen lg:h-[calc(100vh-1.5rem)] bg-sidebar border-r border-sidebar-border lg:border lg:rounded-2xl
          ${animateWidth
            ? 'transition-[width,background-color,border-color,color,transform]'
            : 'transition-[background-color,border-color,color,transform]'}
          duration-200 ease-in-out overflow-hidden
          /* Mobile: fixed drawer from the left. Desktop: sticky, inset by the
             shell's lg:p-3 gutter. */
          fixed lg:sticky top-0 lg:top-3 z-50 lg:z-auto
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
        style={{ width: open ? 224 : 56 }}
      >
      {/* Logo + toggle */}
      <div className={`flex items-center border-b border-sidebar-border ${open ? 'px-4 py-4 gap-2.5 justify-between' : 'px-0 py-4 justify-center'}`}>
        {open && (
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-sidebar-primary flex items-center justify-center shrink-0 shadow-sm">
              <Zap className="w-4 h-4 text-sidebar-primary-foreground" strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold tracking-tight text-sidebar-foreground leading-none">
                Swarm<span className="text-sidebar-primary">Trace</span>
              </div>
            </div>
          </div>
        )}
        {/* Desktop collapse toggle; mobile drawer has its own close button */}
        <button
          onClick={toggleOpen}
          className={`hidden lg:flex w-7 h-7 rounded-lg items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors shrink-0 ${!open ? 'mx-auto' : ''}`}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={open}
        >
          {open ? <X className="w-3.5 h-3.5" /> : <Menu className="w-4 h-4" />}
        </button>
        {/* Mobile close button (hidden on desktop) */}
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden w-7 h-7 rounded-lg flex items-center justify-center text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors shrink-0"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {!open && (
        <div className="flex justify-center py-2 border-b border-sidebar-border">
          <div className="w-7 h-7 rounded-lg bg-sidebar-primary flex items-center justify-center shadow-sm">
            <Zap className="w-4 h-4 text-sidebar-primary-foreground" strokeWidth={2.5} />
          </div>
        </div>
      )}

      <nav
        ref={navRef}
        aria-label="Dashboard navigation"
        data-collapsed={!open}
        className={`sidebar-nav-scroll flex-1 overflow-y-auto overflow-x-hidden overscroll-contain py-3 ${open ? 'px-3 space-y-3' : 'px-0 space-y-3 flex flex-col items-center'}`}
      >
        {navGroups.map((group, gi) => (
          <div key={group.label} className={open ? 'space-y-0.5' : 'space-y-1 flex flex-col items-center'}>
            {open && (
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <NavItem key={item.href} {...item} collapsed={!open} onNavigate={() => setMobileOpen(false)} />
            ))}
            {/* Separator between groups (not after the last group) */}
            {gi < navGroups.length - 1 && open && (
              <div className="mx-2.5 mt-1 border-t border-sidebar-border/50" />
            )}
          </div>
        ))}
      </nav>

      {/* Outside the scrollable nav so the scrollbar stays off these buttons.
          Right padding mirrors the nav's scrollbar gutter. */}
      <div
        className={`shrink-0 border-t border-sidebar-border py-2 space-y-0.5 ${open ? 'px-3' : 'px-0'}`}
        style={open ? { paddingRight: `calc(0.75rem + ${navGutter}px)` } : undefined}
      >
        <SetupGuideButton collapsed={!open} onOpen={() => setMobileOpen(false)} />
        <TakeTourButton collapsed={!open} onStart={() => setMobileOpen(false)} />
      </div>

      {/* User footer */}
      {open ? (
        <div className="px-3 pt-3 pb-5 border-t border-sidebar-border space-y-2">
          <div className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl bg-sidebar-accent">
            <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7 shrink-0' } }} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-sidebar-foreground truncate">{email}</div>
              <div className="text-[11px] text-sidebar-foreground/60">{initials}</div>
            </div>
            <LogoutButton />
          </div>
        </div>
      ) : (
        <div className="px-3 pt-3 pb-5 border-t border-sidebar-border flex flex-col items-center gap-2">
          <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7 shrink-0' } }} />
          <LogoutButton />
        </div>
      )}
    </aside>
    </>
  )
}
