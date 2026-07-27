'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { startStripeOnboarding } from '@/app/app/account/stripe-actions'
import { completeStripeStep } from '../actions'

export function StripeStepForm({
  connected,
  payoutsEnabled,
}: {
  connected: boolean
  payoutsEnabled: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          Connect your <span className="text-gold">bank account</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Melanite uses Stripe Connect to split payments automatically. Your share lands in your
          bank the moment a client pays — no invoicing, no waiting.
        </p>
      </div>

      <div className="rounded-card border border-line p-5">
        <h2 className="text-sm font-medium">How payouts work</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          When a client pays through your checkout link, Stripe splits the payment: half to you,
          half to Melanite, and 100% of any tip to you. Funds typically arrive in two business
          days.
        </p>
        <ul className="mt-4 space-y-2 text-xs text-ink-secondary">
          <li>Bank-grade security — Melanite never sees your account details</li>
          <li>Automatic tax reporting (1099-K issued at year end)</li>
          <li>Setup takes about three minutes</li>
        </ul>
      </div>

      {payoutsEnabled ? (
        <Notice tone="success">
          Stripe is connected and payouts are enabled. You can continue.
        </Notice>
      ) : connected ? (
        // Stripe verifies in the background and tells us via the account.updated webhook. Making
        // someone sit here waiting for that would strand them mid-setup for no reason.
        <Notice tone="warning">
          Stripe has your details and is verifying them. That usually takes a few minutes — you
          can carry on setting up and come back to it.
        </Notice>
      ) : (
        <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
          <strong className="text-warning">Stripe is required.</strong> Without a connected bank
          account you cannot receive payouts or accept bookings.
        </div>
      )}

      {error && <Notice>{error}</Notice>}

      <div className="space-y-2">
        <Button
          block
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await startStripeOnboarding()
              if (result.url) {
                window.location.href = result.url
                return
              }
              setError(result.error ?? 'Could not open Stripe. Try again shortly.')
            })
          }
        >
          {pending
            ? 'Opening Stripe…'
            : connected
              ? 'Continue with Stripe'
              : 'Connect bank account with Stripe'}
        </Button>

        {connected && (
          <Button
            block
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await completeStripeStep()
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
