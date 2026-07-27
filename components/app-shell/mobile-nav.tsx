'use client'

import { useEffect, useRef, useState } from 'react'

import type { NavItem } from '@/lib/nav'

import { Brand } from './brand'
import { NavLinks } from './nav-links'

/** Mobile drawer, matching v1's behaviour: hidden from 768px up, min(280px, 85vw) wide,
 *  slides from the left over a backdrop.
 *
 *  v1 drove this with a MutationObserver over Wized-rendered DOM and a stack of !important
 *  overrides. Here it is component state — but the parts that were easy to lose in that
 *  approach are kept deliberately: Escape closes, the background does not scroll while open,
 *  focus moves into the drawer and returns to the trigger on close, and route changes close
 *  it (handled by NavLinks' onNavigate).
 */
export function MobileNav({ items, children }: { items: NavItem[]; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    // Captured now rather than read in cleanup: by the time cleanup runs the ref may point
    // somewhere else, and focus would be restored to the wrong element or nowhere at all.
    const trigger = triggerRef.current

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)

    // Stop the page behind the drawer from scrolling — on a phone this is the difference
    // between a drawer and a confusing double-scroll.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    panelRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      trigger?.focus()
    }
  }, [open])

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line bg-raised px-4 py-3 md:hidden">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="grid size-9 place-items-center rounded-field text-ink-muted transition-colors hover:bg-overlay hover:text-ink"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none">
            <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <Brand />
      </div>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="relative flex h-full w-[min(280px,85vw)] flex-col border-r border-line bg-raised outline-none"
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-5">
              <Brand />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="grid size-8 place-items-center rounded-field text-ink-muted transition-colors hover:bg-overlay hover:text-ink"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavLinks items={items} onNavigate={() => setOpen(false)} />
            </div>
            {children}
          </div>
        </div>
      )}
    </>
  )
}
