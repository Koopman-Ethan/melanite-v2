'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { acceptRentalTerms, removeRentalCard, startRentalCardSetup } from './billing-actions'

/** The card Melanite charges for laser time.
 *
 *  Replaces the payouts panel, which answered the opposite question. The consequence of an
 *  empty one is different too, and worse in an immediate way: without a connected bank account
 *  a provider could still work and simply never be paid, whereas without a card they cannot
 *  book at all. So this says what is blocked rather than leaving them to find out at the
 *  moment they try to reserve a slot.
 */
export function RentalCard({
  card,
  termsAccepted,
  termsAckAt,
}: {
  card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null
  termsAccepted: boolean
  termsAckAt: Date | null
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const expiry =
    card?.expMonth && card?.expYear
      ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`
      : null

  // Expired, or expiring this month. Worth saying before a booking fails rather than after:
  // a declined card does not hold the slot, so the first sign would be a lost appointment.
  const now = new Date()
  const expired =
    card?.expMonth && card?.expYear
      ? card.expYear < now.getFullYear() ||
        (card.expYear === now.getFullYear() && card.expMonth < now.getMonth() + 1)
      : false

  return (
    <div className="space-y-3">
      {card ? (
        <div className="rounded-field border border-line p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm">
              {card.last4 ? (
                <>
                  {card.brand ? `${card.brand} ` : 'Card '}ending{' '}
                  <strong className="tabular-nums">{card.last4}</strong>
                </>
              ) : (
                <strong>{card.brand ?? 'Payment method'} on file</strong>
              )}
            </span>
            {expiry && (
              <span className={expired ? 'text-xs text-danger' : 'text-xs text-ink-faint'}>
                {expired ? `Expired ${expiry}` : `Expires ${expiry}`}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Charged when you reserve the laser. Sessions Melanite has credited you don&rsquo;t touch it.
          </p>
        </div>
      ) : (
        <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
          <strong className="text-warning">No card on file.</strong> You can&rsquo;t book the
          laser until there is one — the rental fee is charged at the moment you reserve a slot.
        </div>
      )}

      {expired && (
        <Notice>
          That card has expired. Add a current one before your next booking, or it will be
          declined and the slot won&rsquo;t be held.
        </Notice>
      )}

      {!termsAccepted && (
        <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
          <strong className="text-warning">The rental terms have changed.</strong> Accept them to
          carry on booking.
          <Button
            className="mt-3"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await acceptRentalTerms()
                if (result.error) setError(result.error)
              })
            }
          >
            Accept the rental terms
          </Button>
        </div>
      )}

      {termsAccepted && termsAckAt && (
        <p className="text-xs text-ink-faint">
          Rental terms accepted{' '}
          {termsAckAt.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'America/Denver',
          })}
          .
        </p>
      )}

      {error && <Notice>{error}</Notice>}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await startRentalCardSetup()
              if (result.url) {
                window.location.href = result.url
                return
              }
              setError(result.error ?? 'Could not open Stripe. Try again shortly.')
            })
          }
        >
          {card ? 'Replace card' : 'Add a card'}
        </Button>

        {card &&
          (confirming ? (
            // Confirmed in place rather than with a browser dialog, which the rest of this app
            // avoids. Removing the card stops them booking, so it should take a second thought.
            <>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await removeRentalCard()
                    setConfirming(false)
                    if (result.error) setError(result.error)
                  })
                }
              >
                Remove it — I understand I can&rsquo;t book
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            // Outline rather than ghost. A ghost button is transparent with no border and muted
            // text, which is right for an action somebody stumbles past and wrong for one they
            // go looking for — "how do I take my card off this" is a question people arrive
            // with. The two-step confirm below is what keeps it from being an easy mistake.
            <Button variant="outline" disabled={pending} onClick={() => setConfirming(true)}>
              Remove card
            </Button>
          ))}
      </div>
    </div>
  )
}
