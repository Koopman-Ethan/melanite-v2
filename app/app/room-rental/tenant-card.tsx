'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { startRentalCardSetup } from '@/app/app/account/billing-actions'

/**
 * The card a tenant's rent is taken from.
 *
 * The same card on file the daily room and the laser use, set up through the same hosted Stripe
 * page — but without the laser rental terms the account page shows beside it. A tenant has a
 * separate contract with Keoni, and a consent screen about laser fees would describe something
 * they never do.
 */
export function TenantCard({
  card,
  waitingForLease,
}: {
  card: { brand: string | null; last4: string | null } | null
  /** No lease yet: the card is what Keoni needs before she can start one. */
  waitingForLease: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <section className="space-y-3 rounded-card border border-line p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Card on file</h2>
      {card ? (
        <p className="text-sm">
          {card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : 'Card'}
          {card.last4 ? ` ending ${card.last4}` : ''}
        </p>
      ) : (
        <p className="text-sm text-ink-muted">
          {waitingForLease
            ? 'Add a card so Melanite can set up your rental. Your rent is taken from it on the 1st of each month.'
            : 'No card on file. Add one so your rent can be taken.'}
        </p>
      )}
      {waitingForLease && card && (
        <p className="text-xs text-ink-faint">
          You&rsquo;re all set. Melanite will set up your rental and let you know.
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      <Button
        size="sm"
        variant={card ? 'outline' : 'gold'}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await startRentalCardSetup('room-rental')
            if (result.url) {
              window.location.href = result.url
              return
            }
            setError(result.error ?? 'Could not open Stripe. Try again shortly.')
          })
        }
      >
        {pending ? 'Opening Stripe…' : card ? 'Use a different card' : 'Add a card'}
      </Button>
    </section>
  )
}
