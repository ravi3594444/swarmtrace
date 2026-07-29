'use client'

import { useEffect, type RefObject } from 'react'

/**
 * useFocusTrap — traps keyboard focus inside a container while it's open,
 * and restores focus to the previously-focused element when it closes.
 *
 * Used by DetailDrawer, UsageBreakdownDrawer, ConfirmDialog, and the
 * sidebar logout modal so Tab can't escape to the background page (which
 * is both a11y-bad and confusing — focus would land on now-hidden
 * elements behind the overlay).
 *
 * Behavior:
 * - On mount (when `active` is true), record the active element.
 * - Move focus into the container (first focusable, or the container itself).
 * - Trap Tab / Shift+Tab so focus cycles within the container.
 * - On unmount or when `active` turns false, restore focus to the recorded
 *   element.
 *
 * The hook is a no-op when `active` is false, so callers can leave it
 * mounted and toggle the flag.
 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea', 'input', 'select',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    // Filter out elements that aren't actually visible/focusable right now.
    .filter((el) => el.offsetParent !== null || el === document.activeElement)
}

export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    // Record the element that had focus before the trap opened, so we can
    // restore it on close. This matters for keyboard users — without it,
    // focus would jump to <body> after the drawer/dialog closes, forcing
    // them to Tab back to where they were.
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Move focus into the container. Try the first focusable element; if
    // there isn't one, make the container itself focusable and focus it
    // (so ESC/Tab at least have a target).
    const focusables = getFocusable(container)
    if (focusables.length > 0) {
      focusables[0].focus()
    } else {
      container.setAttribute('tabindex', '-1')
      container.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = getFocusable(container)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey) {
        // Shift+Tab from the first element wraps to the last.
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab from the last element wraps to the first.
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    container.addEventListener('keydown', onKey)

    return () => {
      container.removeEventListener('keydown', onKey)
      container.removeAttribute('tabindex')
      // Restore focus to the trigger. setTimeout(0) avoids a race where
      // React hasn't finished unmounting the overlay yet.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        setTimeout(() => previouslyFocused.focus(), 0)
      }
    }
  }, [ref, active])
}
