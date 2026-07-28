'use client'

import { useEffect, useId, useRef, useState } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  /** If set, the confirm button stays disabled until the user types this string exactly. */
  confirmationPhrase?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

// A small dependency-free replacement for window.confirm() on destructive
// actions. window.confirm() is a blocking native dialog that's easy to
// dismiss with a stray Enter/click and gives no room to make the
// consequences of an irreversible action clear — not appropriate for
// something like permanent account deletion.
//
// Split into an outer wrapper (no hooks, just an open/closed gate) and inner
// content that's only mounted while open=true. Mounting fresh each time
// gives clean initial state (typed='') for free instead of resetting it in
// an effect keyed on `open`.
export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null
  return <ConfirmDialogContent {...props} />
}

function ConfirmDialogContent({
  title,
  description,
  confirmationPhrase,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const locked = !!confirmationPhrase && typed !== confirmationPhrase

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">{title}</h2>
        <p id={descId} className="mt-2 text-sm text-muted-foreground">{description}</p>

        {confirmationPhrase && (
          <div className="mt-4">
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Type <span className="font-mono normal-case text-foreground">{confirmationPhrase}</span> to confirm
            </label>
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-destructive/40"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={locked}
            className="rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
