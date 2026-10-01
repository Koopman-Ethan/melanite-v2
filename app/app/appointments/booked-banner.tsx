'use client'

import { CopyButton } from '@/components/ui/copy-button'

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
        <CopyButton value={url} label="Copy link" />
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        The link expires in 7 days. Your client can add a tip at checkout.
      </p>
    </div>
  )
}

/** Shown once, immediately after the laser is reserved under the rental model.
 *
 *  The payment-link banner above has nothing to say here: there is no client, no link and
 *  nothing to send. What a provider needs to know is that the slot is theirs and what it cost
 *  them, because money left their card a second ago. Saying nothing would leave them to find
 *  that on a statement, which is how a fee becomes a complaint.
 */
export function RentalBookedBanner({
  serviceName,
  when,
  chargedCents,
  packSession,
}: {
  serviceName: string
  when: string
  chargedCents: number | null
  packSession: { index: number; total: number } | null
}) {
  return (
    <div className="rounded-card border border-success/30 bg-success/10 p-5">
      <h2 className="text-sm font-medium">
        Laser booked — {serviceName}, {when}
      </h2>

      <p className="mt-1 text-xs text-ink-secondary">
        {packSession
          ? `Session ${packSession.index} of ${packSession.total} from your pack. Nothing was charged to your card.`
          : chargedCents !== null
            ? `$${(chargedCents / 100).toFixed(2)} rental fee charged to your card on file.`
            : 'No rental fee for this appointment.'}
      </p>

      <p className="mt-2 text-xs text-ink-faint">
        Bill your client however you normally do — Melanite isn’t involved in that side of it.
      </p>
    </div>
  )
}
