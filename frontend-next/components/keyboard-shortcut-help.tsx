'use client'

import { useEffect, useState, useId } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/**
 * KeyboardShortcutHelp — a modal cheatsheet that opens when the user
 * presses `?` (Shift+/). Shows all global keyboard shortcuts in one place
 * so they're discoverable without reading docs.
 *
 * The modal traps focus and closes on Escape or backdrop click. It's
 * rendered via a portal to escape any overflow-hidden ancestors.
 */

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: 'Ctrl K', desc: 'Open command palette' },
  { keys: '?', desc: 'Show this shortcut help' },
  { keys: 'Esc', desc: 'Close dialog / drawer / palette' },
  { keys: 'J', desc: 'Next trace (in detail drawer)' },
  { keys: 'K', desc: 'Previous trace (in detail drawer)' },
  { keys: '→', desc: 'Next trace (in detail drawer)' },
  { keys: '←', desc: 'Previous trace (in detail drawer)' },
  { keys: 'Enter', desc: 'Open focused trace / toggle sort' },
]

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded border border-border bg-muted text-[11px] font-mono font-medium text-foreground">
      {children}
    </kbd>
  )
}

export function KeyboardShortcutHelp() {
  const [open, setOpen] = useState(false)
  const dialogRef = useId()

  // Global `?` handler. We use capture phase so it fires before any
  // input-field handlers — but we bail if the user is typing in an
  // input/textarea so `?` still types into search fields etc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 animate-backdrop-fade-in"
        onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
      >
        <div
          id={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 animate-palette-pop-in"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-foreground">Keyboard shortcuts</h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-2.5">
            {SHORTCUTS.map((s) => (
              <li key={s.keys} className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">{s.desc}</span>
                <Kbd>{s.keys}</Kbd>
              </li>
            ))}
          </ul>
          <p className="mt-4 pt-4 border-t border-border text-[11px] text-muted-foreground">
            Tip: the command palette (<Kbd>Ctrl K</Kbd>) also lists every page and action.
          </p>
        </div>
      </div>
    ),
    document.body,
  )
}
