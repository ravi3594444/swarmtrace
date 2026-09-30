'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Traps Tab focus inside a container while `active`, and restores focus to
 * the previously focused element when it turns off. Used by the drawers and
 * modals. No-op when `active` is false.
 */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea', 'input', 'select',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    // skip elements that aren't visible/focusable right now
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

    // remember what had focus so we can restore it on close
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Focus the first focusable element, or the container itself if there
    // isn't one.
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
        // Shift+Tab from the first element wraps to the last
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        // Tab from the last element wraps to the first
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
      // setTimeout(0) so React finishes unmounting the overlay first
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        setTimeout(() => previouslyFocused.focus(), 0)
      }
    }
  }, [ref, active])
}
