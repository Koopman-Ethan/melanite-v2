'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { GROWTH_HUB, MEMBERSHIP_STATUS } from '@/lib/product-names'

import { startEpicutisSubscription } from './actions'

export interface EpicutisView {
  status: 'active' | 'past_due' | 'cancelled' | null
  renewalDate: string | null
  cancelAtPeriodEnd: boolean
  configured: boolean
}

const BENEFITS = [
  'New content every month',
  'Client inquiries from the Melanite website',
  // Stays Epicutis: that is the product brand whose wholesale pricing is the perk, not the
  // name of the membership.
  'Wholesale pricing on Epicutis products',
]

/** The optional provider membership.
 *
 *  Sits beside the medical director plan and is charged the same way, which is exactly why the
 *  copy says plainly that it changes nothing about booking. Two subscriptions on one page,
 *  where one of them IS the booking gate, is a good way for someone to believe they are covered
 *  when they are not. */
export function Epicutis({ epicutis }: { epicutis: EpicutisView }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const subscribed = epicutis.status === 'active' || epicutis.status === 'past_due'

  const badge =
    epicutis.status === 'past_due'
      ? MEMBERSHIP_STATUS.past_due
      : epicutis.status === 'active'
        ? MEMBERSHIP_STATUS.active
        // This card's own absent state. "Not set up" would imply something is wrong; this
        // membership is optional and not having it is a perfectly good place to be.
        : { label: 'Not subscribed', className: 'border-line-strong bg-overlay text-ink-faint' }

  return (
    <section className="rounded-card border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{GROWTH_HUB}</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Optional. $95 / month, cancel anytime.
          </p>
        </div>
        {/* Always rendered, including when they have not subscribed — a card with no badge
            beside one that has always has a badge reads as something missing. */}
        <span className={`rounded-field border px-2.5 py-1 text-xs ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      <ul className="mt-4 space-y-1.5">
        {BENEFITS.map((benefit) => (
          <li key={benefit} className="flex items-baseline gap-2 text-sm text-ink-secondary">
            <span className="text-gold" aria-hidden>
              ·
            </span>
            {benefit}
          </li>
        ))}
      </ul>

      {/* Said out loud, because the page it lives on is the one that decides whether somebody
          can work. Nothing about this membership touches that. */}
      <p className="mt-4 rounded-field border border-line p-3 text-xs leading-relaxed text-ink-muted">
        This is separate from your medical director. Subscribing or cancelling it does not
        affect your ability to book clients.
      </p>

      {epicutis.status === 'past_due' && (
        <p className="mt-3 text-xs text-warning">
          The last payment didn&rsquo;t go through. Update your card in Manage billing below.
        </p>
      )}

      {subscribed && epicutis.renewalDate && (
        <p className="mt-3 text-xs text-ink-faint">
          {epicutis.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on{' '}
          {new Date(epicutis.renewalDate).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
          . Manage or cancel it from Manage billing.
        </p>
      )}

      {error && (
        <div className="mt-4">
          <Notice>{error}</Notice>
        </div>
      )}

      {!subscribed && (
        <div className="mt-5">
          {epicutis.configured ? (
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await startEpicutisSubscription()
                  if (result.url) {
                    window.location.href = result.url
                    return
                  }
                  setError(result.error ?? 'Could not start the subscription.')
                })
              }
            >
              {pending ? 'Opening Stripe…' : 'Subscribe — $95 / month'}
            </Button>
          ) : (
            // Better than a button that fails at Stripe with "No such price".
            <p className="text-sm text-ink-muted">
              Not available yet — Melanite is still setting this up.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
