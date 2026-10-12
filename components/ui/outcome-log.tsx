'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

// What happened, kept on screen until somebody has read it.
//
// THE PROBLEM THIS SOLVES, which this codebase has now hit twice. An action resolves an item in
// a list; the list revalidates; the item disappears — and takes its own confirmation with it.
// The user sees a green flash too brief to read and no record of what was decided. On the
// appointments list it was a cancellation that may or may not have refunded $75. On the review
// queue it was Keoni charging a provider $57.50, which is money moving on somebody's word.
//
// A timer does not fix it. The message is not fading, it is being UNMOUNTED, and no amount of
// delay inside a component that no longer exists will help. The fix has to put the message
// somewhere that outlives the thing it is about — which is what this is.
//
// The log sits above the list and survives it. Messages stay until dismissed, deliberately:
// an outcome that auto-hides is an outcome somebody can miss, and the ones worth logging here
// are the ones that moved money or told a provider something.
//
// USE IT whenever an action's success removes the control that triggered it. If the control
// survives — a form that stays on screen, a toggle that flips — a `Notice` beside it is fine
// and this is ceremony.

export interface Outcome {
  id: string
  message: string
  tone: 'success' | 'error'
}

const OutcomeContext = createContext<{
  record: (message: string, tone?: 'success' | 'error') => void
} | null>(null)

/** Records an outcome from inside a row that is about to vanish. */
export function useOutcomeLog() {
  const ctx = useContext(OutcomeContext)
  if (!ctx) {
    throw new Error('useOutcomeLog must be used inside an <OutcomeLog>')
  }
  return ctx.record
}

export function OutcomeLog({ children }: { children: ReactNode }) {
  const [outcomes, setOutcomes] = useState<Outcome[]>([])

  const record = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    // Newest first. Somebody resolving five items in a row should not have to scroll to see
    // what the last one did.
    setOutcomes((prev) => [
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, message, tone },
      ...prev,
    ])
  }, [])

  const dismiss = (id: string) => setOutcomes((prev) => prev.filter((o) => o.id !== id))

  return (
    <OutcomeContext.Provider value={{ record }}>
      {outcomes.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {outcomes.map((o) => (
            <li
              key={o.id}
              className={
                o.tone === 'success'
                  ? 'flex items-start justify-between gap-3 rounded-card border border-success/30 bg-success/10 p-4 text-sm'
                  : 'flex items-start justify-between gap-3 rounded-card border border-danger/30 bg-danger/10 p-4 text-sm'
              }
            >
              <span>{o.message}</span>
              <button
                type="button"
                onClick={() => dismiss(o.id)}
                className="shrink-0 text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline"
                aria-label="Dismiss"
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
    </OutcomeContext.Provider>
  )
}
