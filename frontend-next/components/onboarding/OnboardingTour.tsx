'use client'

/**
 * OnboardingTour — a guided, step-by-step product tour for new users.
 *
 * New sign-ups are walked through each dashboard feature one at a time with a
 * spotlight over the relevant sidebar item and a short explanation, because
 * several features (Threads, Compare, Failure clustering) aren't obvious at
 * first glance. The tour auto-starts once per user (tracked in localStorage,
 * keyed by the Clerk user id) and can be replayed anytime from the sidebar.
 *
 * It is intentionally dependency-free: the spotlight is a transparent element
 * with a large box-shadow that dims everything else, and the tooltip is
 * positioned against the target's bounding rect and clamped to the viewport.
 */

import {
  createContext, useCallback, useContext, useEffect, useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { useUser } from '@clerk/nextjs'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { TOUR_STEPS, type TourStep } from './tour-steps'

const STORAGE_PREFIX = 'swarmtrace-onboarding-completed:'
const SPOTLIGHT_PADDING = 8

type Rect = { top: number; left: number; width: number; height: number }

type TourContextValue = { startTour: () => void }

const TourContext = createContext<TourContextValue | null>(null)

/** Access `startTour()` — e.g. from a "Take a tour" button in the sidebar. */
export function useOnboardingTour(): TourContextValue {
  const ctx = useContext(TourContext)
  if (!ctx) {
    // Return a no-op so consumers rendered outside the provider don't crash.
    return { startTour: () => {} }
  }
  return ctx
}

function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${userId ?? 'anon'}`
}

/** Measure a target element, or null if it isn't in the DOM. */
function measure(selector: string | undefined): Rect | null {
  if (!selector || typeof document === 'undefined') return null
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

const CARD_WIDTH = 320

/**
 * Compute the card's `position: fixed` style from the target rect. Purely
 * derived from the rect (no DOM measurement of the card itself) so it needs
 * no effect: the card's own size is handled with CSS transforms, and only its
 * known fixed width is used for horizontal viewport clamping.
 */
function cardStyleFor(rect: Rect | null, placement: TourStep['placement']): React.CSSProperties {
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  }
  const gap = 14
  const margin = 12
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const place = placement ?? 'right'

  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  let top: number
  let left: number
  let transform: string

  // Flip a right-placed card to the left when it would overflow the viewport.
  const effective =
    place === 'right' && rect.left + rect.width + gap + CARD_WIDTH > vw - margin
      ? 'left'
      : place

  switch (effective) {
    case 'left':
      left = rect.left - gap
      top = cy
      transform = 'translate(-100%, -50%)'
      break
    case 'top':
      left = cx
      top = rect.top - gap
      transform = 'translate(-50%, -100%)'
      break
    case 'bottom':
      left = cx
      top = rect.top + rect.height + gap
      transform = 'translate(-50%, 0)'
      break
    case 'right':
    default:
      left = rect.left + rect.width + gap
      top = cy
      transform = 'translate(0, -50%)'
      break
  }

  // Horizontal clamp using the known fixed card width.
  const half = effective === 'right' || effective === 'left' ? 0 : CARD_WIDTH / 2
  const minLeft = margin + (effective === 'left' ? CARD_WIDTH : half)
  const maxLeft = vw - margin - (effective === 'right' ? CARD_WIDTH : half)
  left = Math.max(minLeft, Math.min(left, maxLeft))

  return { top, left, transform }
}

/** Tooltip card. Positioned relative to `rect`, or centred when rect is null. */
function TourCard({
  step, index, total, rect, onNext, onPrev, onClose,
}: {
  step: TourStep
  index: number
  total: number
  rect: Rect | null
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}) {
  const Icon = step.icon
  const style = cardStyleFor(rect, step.placement)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tour step ${index + 1} of ${total}: ${step.title}`}
      className="fixed z-[1001] w-[320px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-card shadow-2xl"
      style={style}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{step.title}</h2>
          <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Step {index + 1} of {total}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tour"
          className="-mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="px-4 pt-3 text-[13px] leading-relaxed text-muted-foreground">
        {step.body}
      </p>

      {/* Progress dots */}
      <div className="flex items-center gap-1.5 px-4 pt-4">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${
              i === index ? 'w-4 bg-primary' : 'w-1.5 bg-border'
            }`}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-4">
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={onPrev}
              className="flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            className="flex h-8 items-center gap-1 rounded-lg bg-primary px-3.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
          >
            {index === total - 1 ? 'Finish' : 'Next'}
            {index !== total - 1 && <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  )
}

function TourOverlay({
  onFinish,
}: {
  onFinish: () => void
}) {
  const router = useRouter()
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const step = TOUR_STEPS[index]
  const total = TOUR_STEPS.length

  // Navigate to the step's route (if any) before locating the target.
  useEffect(() => {
    if (step.route) router.push(step.route)
  }, [step.route, router])

  // Locate the target element, retrying briefly while the page mounts.
  useEffect(() => {
    let cancelled = false
    let raf = 0
    const attempt = (tries: number) => {
      if (cancelled) return
      const next = measure(step.target)
      setRect(next)
      if (!next && step.target && tries > 0) {
        raf = window.setTimeout(() => attempt(tries - 1), 80)
      }
    }
    attempt(20)
    return () => {
      cancelled = true
      window.clearTimeout(raf)
    }
  }, [step.target, index])

  // Keep the spotlight aligned on scroll / resize.
  useEffect(() => {
    if (!step.target) return
    const update = () => setRect(measure(step.target))
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [step.target])

  const next = useCallback(() => {
    setIndex((i) => {
      if (i >= total - 1) {
        onFinish()
        return i
      }
      return i + 1
    })
  }, [total, onFinish])

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') prev()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [next, prev, onFinish])

  const spotlight: React.CSSProperties | null = rect
    ? {
        position: 'fixed',
        top: rect.top - SPOTLIGHT_PADDING,
        left: rect.left - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
        borderRadius: 12,
        boxShadow: '0 0 0 9999px rgba(9, 9, 11, 0.55)',
        zIndex: 1000,
        pointerEvents: 'none',
        transition: 'top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease',
      }
    : null

  return (
    <>
      {spotlight ? (
        <div style={spotlight} aria-hidden />
      ) : (
        // No target: plain dim backdrop for the centred welcome/finish cards.
        <div
          className="fixed inset-0 z-[1000] bg-zinc-950/55"
          aria-hidden
          onClick={onFinish}
        />
      )}
      <TourCard
        step={step}
        index={index}
        total={total}
        rect={rect}
        onNext={next}
        onPrev={prev}
        onClose={onFinish}
      />
    </>
  )
}

export function OnboardingTourProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser()
  const [active, setActive] = useState(false)

  const finish = useCallback(() => {
    setActive(false)
    if (typeof window !== 'undefined' && user?.id) {
      try {
        window.localStorage.setItem(storageKey(user.id), '1')
      } catch {
        // localStorage may be unavailable (private mode); tour just re-shows.
      }
    }
  }, [user?.id])

  const startTour = useCallback(() => setActive(true), [])

  // Auto-start once for users who haven't seen the tour yet.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user?.id) return
    if (typeof window === 'undefined') return
    let seen = false
    try {
      seen = window.localStorage.getItem(storageKey(user.id)) === '1'
    } catch {
      seen = false
    }
    if (!seen) setActive(true)
  }, [isLoaded, isSignedIn, user?.id])

  return (
    <TourContext.Provider value={{ startTour }}>
      {children}
      {active && createPortal(<TourOverlay onFinish={finish} />, document.body)}
    </TourContext.Provider>
  )
}
