'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'

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
 *  Renders the shared `Button`, which is what guarantees the 44px touch target. The hand-rolled
 *  markup this replaced was about 29px tall — reintroducing, in the one control a provider taps
 *  one-handed between clients, exactly the problem `Button`'s `sm` size was corrected for.
 *
 *  Now the only copy button in the app: `booked-banner.tsx` had this logic inline, and
 *  `template-list.tsx` had a fire-and-forget version with no feedback at all.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'outline',
  size = 'sm',
  className,
}: {
  value: string
  label?: string
  copiedLabel?: string
  variant?: 'gold' | 'outline' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
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
    <Button
      type="button"
      onClick={copy}
      variant={variant}
      size={size}
      // Announced rather than only shown. The label change is invisible to somebody using a
      // screen reader unless the region says it updated.
      aria-live="polite"
      className={className}
    >
      {copied ? copiedLabel : label}
    </Button>
  )
}
