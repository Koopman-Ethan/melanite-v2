'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { EmailField } from '@/components/ui/validated-field'

import { createPrepaidIntent } from '../../actions'
import { CardForm } from '../../card-form'

export interface PrepaidSummary {
  amount: string
  providerName: string
  providerCredentials: string | null
  clientName: string | null
  /** Set when the provider recorded that somebody else is buying this. */
  purchaserName: string | null
  purchaserEmail: string | null
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Paying for a prepaid balance.
 *
 *  Deliberately simpler than the package page: no tip, no line items, no Cherry, and no
 *  card-on-file consent. Every one of those belongs to an appointment, and this is not one —
 *  asking somebody to authorise no-show charges months before anything is booked would be
 *  collecting consent under the wrong pretext.
 *
 *  The one thing this page must be unambiguous about is WHO the money is for, because for a
 *  gift the person paying is not the person who gets it.
 */
export function PrepaidCheckoutForm({
  token,
  summary,
}: {
  token: string
  summary: PrepaidSummary
}) {
  const [email, setEmail] = useState(summary.purchaserEmail ?? '')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [amount, setAmount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [paid, setPaid] = useState(false)
  const [pending, start] = useTransition()

  const forSomeoneElse = Boolean(summary.purchaserName)
  const beneficiary = summary.clientName ?? 'the client'

  function beginPayment() {
    setError(null)
    start(async () => {
      const result = await createPrepaidIntent({
        token,
        purchaserEmail: email.trim() || null,
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setClientSecret(result.clientSecret ?? null)
      setAmount(result.amount ?? Number(summary.amount))
    })
  }

  if (paid) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 text-center">
        <div className="rounded-card border border-success/30 bg-success/10 p-8">
          <h1 className="text-xl font-semibold">Balance added</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            {usd(amount)} is now on {beneficiary}&rsquo;s account with {summary.providerName}.
          </p>
        </div>
        <p className="text-xs text-ink-faint">
          {forSomeoneElse
            ? `${beneficiary} can put it towards any appointment with ${summary.providerName}. It does not expire.`
            : `Put it towards any appointment with ${summary.providerName} — it is applied when you book, and it does not expire.`}
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-5">
      <section className="rounded-card border border-line bg-surface p-5">
        <h1 className="text-lg font-semibold">Prepaid balance</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          with {summary.providerName}
          {summary.providerCredentials && (
            <span className="text-ink-faint">, {summary.providerCredentials}</span>
          )}
        </p>

        <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
          <span className="font-medium">Amount</span>
          <span className="text-xl font-semibold tabular-nums">{usd(summary.amount)}</span>
        </div>

        {/* Stated plainly, and before payment. Somebody buying a gift needs to know the money
            will not be on their own account, and the beneficiary is not derived from whose
            card is used — it was chosen when the link was made. */}
        <p className="mt-3 rounded-field border border-line bg-overlay px-3 py-2 text-xs text-ink-secondary">
          {forSomeoneElse
            ? `This goes onto ${beneficiary}'s account, not yours. It is theirs to spend on any appointment with ${summary.providerName}.`
            : `This goes onto ${beneficiary}'s account, to spend on any appointment with ${summary.providerName}.`}
        </p>

        <ul className="mt-3 space-y-1 text-xs text-ink-faint">
          <li>It never expires.</li>
          <li>It is not refundable.</li>
          <li>It can go towards any service, at whatever that service costs on the day.</li>
        </ul>
      </section>

      {!clientSecret && (
        <>
          <section className="space-y-3 rounded-card border border-line bg-surface p-5">
            <EmailField
              id="purchaserEmail"
              label="Email for your receipt"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              optional
              hint={
                forSomeoneElse
                  ? 'The receipt goes here, not to the person receiving the balance.'
                  : 'Stripe emails your receipt to this address.'
              }
            />
          </section>

          {error && <Notice>{error}</Notice>}

          <Button block onClick={beginPayment} disabled={pending}>
            {pending ? 'Preparing…' : `Pay by card · ${usd(summary.amount)}`}
          </Button>
        </>
      )}

      {clientSecret && (
        <section className="space-y-4 rounded-card border border-line bg-surface p-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-secondary">Total</span>
            <span className="text-xl font-semibold tabular-nums">{usd(amount)}</span>
          </div>
          <CardForm clientSecret={clientSecret} amount={amount} onPaid={() => setPaid(true)} />
          <button
            type="button"
            onClick={() => setClientSecret(null)}
            className="w-full text-center text-xs text-ink-faint underline-offset-4 hover:underline"
          >
            Change your details
          </button>
        </section>
      )}
    </div>
  )
}
