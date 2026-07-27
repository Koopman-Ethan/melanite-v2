import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

// Real form elements.
//
// v1 used faux-input divs throughout, not by choice — the Webflow MCP silently rejected
// payloads containing raw <input>/<select>, so the workaround became the pattern. That
// constraint does not exist here, so these are actual inputs with actual labels, which means
// autofill, password managers, and screen readers all work without special handling.

export interface FieldProps extends Omit<ComponentProps<'input'>, 'className' | 'id'> {
  id: string
  label: string
  hint?: ReactNode
  error?: string
}

export function Field({ id, label, hint, error, required, ...props }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div className="space-y-1.5">
      {/* The asterisk is drawn by CSS rather than added to the label's text.
          `required` on the input is what actually tells assistive tech, so the marker is purely
          visual — and putting it in the DOM changes the label's accessible name from "Name" to
          "Name *", which silently breaks every caller and test that matches a label exactly. */}
      <label
        htmlFor={id}
        className={cn(
          'block text-sm font-medium text-ink-secondary',
          required && "after:ml-1 after:text-gold after:content-['*']",
        )}
      >
        {label}
      </label>
      <input
        id={id}
        required={required}
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? true : undefined}
        {...props}
        className={cn(
          // min-h-11 is a 44px touch target — the size a fingertip actually needs.
        'w-full min-h-11 rounded-field border bg-surface px-3 py-2 text-sm text-ink',
          'placeholder:text-ink-faint',
          // `line-control`, not `line`: an empty input bounded by a #2a2a2a hairline is
          // genuinely hard to locate on a dark page, and WCAG 1.4.11 asks for 3:1 on anything
          // needed to identify a component.
          error ? 'border-danger' : 'border-line-control focus:border-gold',
        )}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-ink-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** Inline status message. `role="alert"` only for errors — announcing a success banner as an
 *  alert interrupts screen reader users for no reason. */
export function Notice({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'success' | 'warning'
  children: ReactNode
}) {
  const tones = {
    error: 'border-danger/30 bg-danger/10 text-danger',
    success: 'border-success/30 bg-success/10 text-ink-secondary',
    warning: 'border-warning/40 bg-warning/10 text-ink-secondary',
  } as const

  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn('rounded-field border px-3 py-2.5 text-sm', tones[tone])}
    >
      {children}
    </p>
  )
}
