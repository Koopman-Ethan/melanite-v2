'use client'

import { useState } from 'react'

/** Shown once, immediately after booking.
 *
 *  The payment link exists from the moment the booking does, but until this banner there was
 *  nowhere it was ever displayed — it was generated and shown to nobody, which made the whole
 *  checkout flow unreachable unless the provider went digging in the database.
 *
 *  The link is offered for copying even when the email went out, because most of these travel
 *  by text message. Email is a convenience, not the delivery mechanism.
 */
export function BookedBanner({
  url,
  clientName,
  clientEmail,
  emailed,
}: {
  url: string
  clientName: string
  clientEmail: string | null
  emailed: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused. The link is on screen and selectable, so this is a
      // convenience failing rather than the feature failing.
      setCopied(false)
    }
  }

  return (
    <div className="rounded-card border border-success/30 bg-success/10 p-5">
      <h2 className="text-sm font-medium">Booked for {clientName}</h2>

      <p className="mt-1 text-xs text-ink-secondary">
        {emailed
          ? `The payment link has been emailed to ${clientEmail}. Send it by text too if that's how they prefer.`
          : clientEmail
            ? `Email isn't set up yet, so nothing was sent — copy the link and send it to ${clientEmail} yourself.`
            : 'No email was given, so send this link to your client directly.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-field border border-line bg-surface px-3 py-2 text-xs text-ink-secondary">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-control border border-line-strong px-3 py-2 text-xs font-bold tracking-[0.3px] text-ink-secondary transition-colors hover:border-ink-faint hover:bg-overlay"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        The link expires in 7 days. Your client can add a tip at checkout.
      </p>
    </div>
  )
}
