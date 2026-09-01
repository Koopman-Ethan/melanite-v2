'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Notice } from '@/components/ui/field'
import { reissueBookingLink, resendBookingLink, type LinkState } from './link-actions'

/** The client's payment link, on the appointment it belongs to.
 *
 *  Shown for any unpaid link, not just a fresh one — the whole point is the day AFTER booking,
 *  when the banner is long gone and a client has asked for it again.
 *
 *  Nothing here for a paid, cancelled or link-less booking: a comped or externally-paid
 *  appointment never had a link, and offering one would invite taking the money twice. */
export function PaymentLink({
  bookingId,
  url,
  status,
  expiresAt,
  hasEmail,
}: {
  bookingId: string
  url: string
  status: string
  expiresAt: Date
  hasEmail: boolean
}) {
  const [state, setState] = useState<LinkState>({})
  const [pending, start] = useTransition()

  if (status !== 'pending') return null

  const expired = expiresAt < new Date()

  function run(action: (id: string) => Promise<LinkState>) {
    setState({})
    start(async () => setState(await action(bookingId)))
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-xs font-medium text-ink-secondary">
        {expired ? 'Payment link — expired' : 'Awaiting payment'}
      </p>

      {expired ? (
        <p className="mt-1 text-xs text-ink-faint">
          This link stopped working on {expiresAt.toLocaleDateString('en-US', { timeZone: 'America/Denver' })}.
          A new one replaces it{hasEmail && ' and is emailed straight to them'}.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-field border border-line bg-surface px-3 py-2 text-xs text-ink-secondary">
            {url}
          </code>
          <CopyButton value={url} label="Copy link" />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {expired ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(reissueBookingLink)}>
            {pending ? 'Working…' : 'Issue a new link'}
          </Button>
        ) : (
          hasEmail && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(resendBookingLink)}>
              {pending ? 'Sending…' : 'Email it again'}
            </Button>
          )
        )}
        {!hasEmail && !expired && (
          <span className="text-xs text-ink-faint">
            No email on file — copy it and text it across.
          </span>
        )}
      </div>

      {state.error && (
        <div className="mt-2">
          <Notice>{state.error}</Notice>
        </div>
      )}
      {state.success && <p className="mt-2 text-xs text-success">{state.success}</p>}
    </div>
  )
}
