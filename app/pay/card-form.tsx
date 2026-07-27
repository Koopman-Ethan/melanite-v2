'use client'

import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js'
import { loadStripe, type Appearance } from '@stripe/stripe-js'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

// Stripe Elements, styled to match the app.
//
// The card fields are rendered by Stripe inside an iframe, so no card number ever touches this
// origin — same PCI position as a hosted redirect, without sending the client to a domain that
// is not Melanite's. That matters here and nowhere else in the app: this is the only page a
// paying client sees.

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

/** Loaded once per page, outside the component. `loadStripe` injects a script tag; calling it
 *  on every render would add one on every keystroke. */
const stripePromise = publishableKey ? loadStripe(publishableKey) : null

const APPEARANCE: Appearance = {
  theme: 'night',
  variables: {
    colorPrimary: '#c9a227',
    colorBackground: '#141414',
    colorText: '#ededed',
    colorTextSecondary: '#a1a1a1',
    colorDanger: '#e5484d',
    fontSizeBase: '14px',
    borderRadius: '6px',
    spacingUnit: '4px',
  },
}

function PayForm({
  amount,
  onPaid,
}: {
  amount: number
  onPaid: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const usd = amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return

    setBusy(true)
    setError(null)

    // `if_required` keeps the client on this page unless their bank demands a redirect for
    // 3D Secure. Most cards will not, and bouncing everyone through a redirect to handle the
    // minority is a worse experience for the majority.
    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: window.location.href },
    })

    if (result.error) {
      // Stripe's card errors are written for the cardholder and are safe to show. Anything
      // else gets a generic line.
      setError(
        result.error.type === 'card_error' || result.error.type === 'validation_error'
          ? (result.error.message ?? 'That card was declined.')
          : 'Something went wrong taking the payment. No charge was made.',
      )
      setBusy(false)
      return
    }

    // The webhook is what actually records the payment. This only changes what the client
    // sees — a closed tab mid-confirmation still ends up paid and recorded.
    onPaid()
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ layout: 'tabs' }} />

      {error && <Notice>{error}</Notice>}

      <Button type="submit" block disabled={!stripe || busy}>
        {busy ? 'Processing…' : `Pay ${usd}`}
      </Button>

      <p className="text-center text-xs text-ink-faint">
        Payments are processed by Stripe. Melanite never sees your card number.
      </p>
    </form>
  )
}

export function CardForm({
  clientSecret,
  amount,
  onPaid,
}: {
  clientSecret: string
  amount: number
  onPaid: () => void
}) {
  const options = useMemo(
    () => ({ clientSecret, appearance: APPEARANCE }),
    [clientSecret],
  )

  if (!stripePromise) {
    return (
      <Notice>
        Card payments aren&rsquo;t configured yet. Contact Melanite and they&rsquo;ll take payment
        another way.
      </Notice>
    )
  }

  return (
    <Elements stripe={stripePromise} options={options}>
      <PayForm amount={amount} onPaid={onPaid} />
    </Elements>
  )
}
