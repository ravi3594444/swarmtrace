'use client'

import { useEffect, type RefObject } from 'react'

/**
 * useDismissibleDropdown — closes an open dropdown/menu on outside click or
 * Escape. Extracted from the pattern already used correctly by
 * components/swarm/TimeRangeDropdown.tsx.
 *
 * Audit finding: 4 of the app's 7 open-state dropdowns (AgentPicker,
 * both ExportMenu copies, DateRangePicker) had no Escape handling, no
 * outside-click handling (or only a partial `fixed inset-0` overlay), and
 * no `aria-expanded` — keyboard users had no way to back out once open.
 * This hook is a no-op while `open` is false, so callers just wire it in
 * alongside their existing `open` state.
 */
export function useDismissibleDropdown(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, ref])
}
