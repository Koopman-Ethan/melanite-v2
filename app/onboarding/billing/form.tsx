'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import {
  acceptRentalTerms,
  startRentalCardSetup,
  withdrawRentalTerms,
} from '@/app/app/account/billing-actions'
import { completeBillingStep } from '../actions'

export interface TierView {
  key: string
  label: string
  singleCents: number
  /** What the guide suggests charging a client. Advisory — see `RentalTier`. */
  suggestedLowCents: number
  suggestedHighCents: number
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Step 4 — the card Melanite charges, and what it will be charged for.
 *
 *  The fee schedule is shown in full here rather than linked. A provider is agreeing to pay
 *  these amounts; putting them one click away makes "I didn't know what it cost" a reasonable
 *  thing for somebody to say later.
 */
export function BillingStepForm({
  card,
  termsAccepted,
  terms,
  tiers,
}: {
  card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null
  termsAccepted: boolean
  terms: { key: string; text: string }[]
  tiers: TierView[]
}) {
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(termsAccepted)
  // TWO transitions, not one. They were sharing it, so ticking the terms box put the card
  // button into its pending state and it announced "Opening Stripe…" — about a click that had
  // nothing to do with Stripe.
  const [savingTerms, startTerms] = useTransition()
  const [openingStripe, startStripe] = useTransition()
  const pending = savingTerms || openingStripe

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          A card for <span className="text-gold">equipment rental</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Melanite charges a flat fee each time you book the laser, taken when you reserve the
          time. You bill your own clients, at your own prices — none of that comes through here.
        </p>
      </div>

      <details className="rounded-card border border-line p-5">
        <summary className="cursor-pointer text-sm font-medium">
          What each session costs
        </summary>
        <div className="mt-4 space-y-3">
          {tiers.map((tier) => (
            <div key={tier.key} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs text-ink-secondary">{tier.label}</span>
              <span className="text-xs tabular-nums">
                <strong>{usd(tier.singleCents)}</strong>
                {/* What the market charges, so the fee reads as a share rather than a cost.
                    Advisory only — the guide is emphatic that providers set their own prices. */}
                <span className="text-ink-faint">
                  {' '}
                  · typically sells for{' '}
                  {tier.suggestedLowCents === tier.suggestedHighCents
                    ? usd(tier.suggestedLowCents)
                    : `${usd(tier.suggestedLowCents)}–${usd(tier.suggestedHighCents)}`}
                </span>
              </span>
            </div>
          ))}
          <p className="text-xs text-ink-faint">
            The right-hand figure is what the guide found local clinics charging. It&rsquo;s a
            reference, not a price you have to use — what you charge is yours to decide.
          </p>
        </div>
      </details>

      <div className="rounded-card border border-line p-5">
        <h2 className="text-sm font-medium">The terms</h2>
        <ul className="mt-3 space-y-2">
          {terms.map((t) => (
            <li key={t.key} className="text-xs leading-relaxed text-ink-secondary">
              {t.text}
            </li>
          ))}
        </ul>

        <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={checked}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked
              setChecked(next)
              setError(null)
              // Recorded the moment it is ticked, not on submit. The acknowledgement is a fact
              // about what somebody agreed to and when — losing it because they closed the tab
              // before pressing a button would mean asking again with no record either way.
              startTerms(async () => {
                const result = next ? await acceptRentalTerms() : await withdrawRentalTerms()
                if (result.error) {
                  setChecked(!next)
                  setError(result.error)
                }
              })
            }}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="text-ink-secondary">
            I&rsquo;ve read and accept the rental terms and the fee schedule above.
          </span>
        </label>
      </div>

      {card ? (
        <Notice tone="success">
          {/* A payment method without a last four is a wallet rather than a card. Rare now that
              the session asks for a card explicitly, but it must read as "we have one" — the
              alternative is a blank where a number goes, which reads as broken. */}
          {card.last4
            ? `${card.brand ? `${card.brand} ` : 'Card '}ending ${card.last4}`
            : `${card.brand ?? 'Payment method'} on file`}
          {card.expMonth && card.expYear
            ? ` · expires ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`
            : ''}
          . You can continue.
        </Notice>
      ) : (
        <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
          <strong className="text-warning">A card is required.</strong> The rental fee is charged
          when you reserve the laser, so without one you can&rsquo;t book.
        </div>
      )}

      {error && <Notice>{error}</Notice>}

      <div className="space-y-2">
        {/* Not reachable until the terms are accepted. Handing over a card before agreeing to
            what it will be charged is the wrong order, and the fee schedule is part of what is
            being agreed to. */}
        <Button
          block
          variant={card ? 'outline' : 'gold'}
          disabled={pending || !checked}
          onClick={() =>
            startStripe(async () => {
              const result = await startRentalCardSetup()
              if (result.url) {
                window.location.href = result.url
                return
              }
              setError(result.error ?? 'Could not open Stripe. Try again shortly.')
            })
          }
        >
          {openingStripe
            ? 'Opening Stripe…'
            : !checked
              ? 'Accept the terms first'
              : card
                ? 'Use a different card'
                : 'Add a card with Stripe'}
        </Button>

        {card && (
          <Button
            block
            disabled={pending || !checked}
            onClick={() =>
              startStripe(async () => {
                const result = await completeBillingStep()
                if (result?.error) setError(result.error)
              })
            }
          >
            Next step
          </Button>
        )}
      </div>
    </div>
  )
}
