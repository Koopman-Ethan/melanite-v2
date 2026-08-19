'use client'

import { useState } from 'react'

/** Copy-to-clipboard with the confirmation that makes it believable.
 *
 *  A copy button that looks identical before and after leaves somebody clicking it twice and
 *  then pasting somewhere else to check. The label swap is the whole point.
 *
 *  Clipboard access can be refused outright — an insecure origin, a permission policy, a
 *  browser that wants a user gesture it did not see. The link is on screen and selectable in
 *  every case this is used, so a failure here is a convenience not working rather than the
 *  feature not working, and it stays silent instead of raising an error about it.
 *
 *  Extracted from `booked-banner.tsx`, which had it inline. `template-list.tsx` still has a
 *  copy button with no feedback and could use this too.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  className,
}: {
  value: string
  label?: string
  copiedLabel?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      // Announced rather than only shown. The label change is invisible to somebody using a
      // screen reader unless the region says it updated.
      aria-live="polite"
      className={
        className ??
        'rounded-control border border-line-strong px-3 py-2 text-xs font-bold tracking-[0.3px] text-ink-secondary transition-colors hover:border-ink-faint hover:bg-overlay'
      }
    >
      {copied ? copiedLabel : label}
    </button>
  )
}
