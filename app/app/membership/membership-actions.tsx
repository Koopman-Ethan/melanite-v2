'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'

import { openBillingPortal, startSubscription, type StripeRedirect } from './actions'

/** Subscribe / manage-billing.
 *
 *  Both hand off to Stripe rather than collecting card details here — v1 did the same, and it
 *  keeps this app out of PCI scope entirely.
 */
export function MembershipActions({
  type,
  status,
  planConfigured,
  hasStripeSubscription,
}: {
  type: 'melanite' | 'own' | null
  status: 'none' | 'active' | 'past_due' | 'inactive'
  planConfigured: boolean
  hasStripeSubscription: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The own-director path has nothing to click: changing it means a new signed supervision
  // agreement, which goes through Melanite.
  if (type === 'own') return null

  const go = (fn: () => Promise<StripeRedirect>) => {
    startTransition(async () => {
      const result = await fn()
      if (result.url) window.location.href = result.url
      else setError(result.error ?? 'Something went wrong.')
    })
  }

  const canSubscribe = status !== 'active' && status !== 'past_due'

  return (
    <div className="space-y-2">
      {canSubscribe ? (
        <Button disabled={pending || !planConfigured} onClick={() => go(startSubscription)}>
          {pending ? 'Opening…' : 'Start — $150/month'}
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !hasStripeSubscription}
          onClick={() => go(openBillingPortal)}
        >
          {pending ? 'Opening…' : status === 'past_due' ? 'Update payment' : 'Manage billing'}
        </Button>
      )}

      {!planConfigured && canSubscribe && (
        <p className="max-w-56 text-xs text-ink-faint">
          Melanite hasn&rsquo;t finished configuring the plan. Contact them to get set up.
        </p>
      )}

      {error && <p className="max-w-56 text-xs text-danger">{error}</p>}
    </div>
  )
}
