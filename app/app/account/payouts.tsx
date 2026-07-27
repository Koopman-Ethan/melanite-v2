'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { openStripeDashboard, startStripeOnboarding, type StripeRedirect } from './stripe-actions'

/** Getting paid.
 *
 *  Separated from the rest of Account because the consequence is different in kind: without a
 *  connected account a provider can still work, still book, still be owed money — and simply
 *  never receive any of it. Nothing else on this page can cost them that.
 */
export function Payouts({ connected }: { connected: boolean }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const go = (fn: () => Promise<StripeRedirect>) =>
    startTransition(async () => {
      const result = await fn()
      if (result.url) window.location.href = result.url
      else setError(result.error ?? 'Something went wrong.')
    })

  return (
    <div className="space-y-3">
      <div
        className={
          connected
            ? 'rounded-card border border-line bg-surface p-5'
            : 'rounded-card border border-warning/40 bg-warning/10 p-5'
        }
      >
        {connected ? (
          <>
            <p className="text-sm text-ink-secondary">
              Stripe is connected. Your share of each appointment is sent to your bank
              automatically.
            </p>
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => go(openStripeDashboard)}
              >
                {pending ? 'Opening…' : 'View payouts in Stripe'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-sm font-medium text-warning">You can’t be paid yet</h3>
            <p className="mt-1 text-sm text-ink-secondary">
              Connect a Stripe account so your share of each appointment reaches your bank.
              Until then, money you earn stays with Melanite.
            </p>
            <div className="mt-3">
              <Button disabled={pending} onClick={() => go(startStripeOnboarding)}>
                {pending ? 'Opening…' : 'Connect Stripe'}
              </Button>
            </div>
          </>
        )}
      </div>

      {error && <Notice>{error}</Notice>}
    </div>
  )
}
