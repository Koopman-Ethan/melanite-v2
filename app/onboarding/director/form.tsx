'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { startSubscription } from '@/app/app/membership/actions'
import { saveDirectorChoice } from '../actions'

const CONTACT = 'melanitelasersuite@gmail.com'

export function DirectorForm({
  initialChoice,
  subscriptionActive,
}: {
  initialChoice: 'melanite' | 'own' | null
  subscriptionActive: boolean
}) {
  const [choice, setChoice] = useState<'melanite' | 'own'>(initialChoice ?? 'melanite')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          Your <span className="text-gold">medical director</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Laser treatments require physician oversight. Choose Melanite&rsquo;s medical director,
          or bring your own.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            {
              key: 'melanite' as const,
              title: 'Melanite medical director',
              price: '$150 / month',
              body: 'We provide a licensed medical director. Billed monthly, cancel anytime. Required to take bookings.',
            },
            {
              key: 'own' as const,
              title: 'Use my own director',
              price: 'No monthly fee',
              body: "Bring your own physician. You'll provide their details and a signed supervision agreement.",
            },
          ] as const
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setChoice(option.key)}
            aria-pressed={choice === option.key}
            className={cn(
              'rounded-card border p-4 text-left transition-colors',
              choice === option.key
                ? 'border-gold bg-gold/5'
                : 'border-line hover:border-line-strong',
            )}
          >
            <span className="block text-sm font-medium">{option.title}</span>
            <span className="mt-1 block text-sm text-gold">{option.price}</span>
            <span className="mt-2 block text-xs leading-relaxed text-ink-muted">{option.body}</span>
          </button>
        ))}
      </div>

      {choice === 'melanite' ? (
        <>
          <dl className="rounded-card border border-line p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Plan</dt>
              <dd>Melanite medical director</dd>
            </div>
            <div className="mt-2 flex justify-between">
              <dt className="text-ink-muted">Price</dt>
              <dd className="tabular-nums">$150 / month</dd>
            </div>
            <div className="mt-2 flex justify-between">
              <dt className="text-ink-muted">Status</dt>
              <dd className={subscriptionActive ? 'text-success' : 'text-warning'}>
                {subscriptionActive ? 'Active' : 'Not active'}
              </dd>
            </div>
          </dl>

          {!subscriptionActive && (
            <Button
              block
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await startSubscription()
                  if (result.url) {
                    window.location.href = result.url
                    return
                  }
                  setError(result.error ?? 'Could not start the subscription.')
                })
              }
            >
              {pending ? 'Opening Stripe…' : 'Subscribe — $150 / month'}
            </Button>
          )}
        </>
      ) : (
        <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
          <strong className="text-ink">Documents pending.</strong> We&rsquo;ll collect your
          medical director&rsquo;s details and signed supervision agreement separately — Melanite
          will reach out to finish verifying the arrangement. You can carry on setting up now.
        </div>
      )}

      {/* Stated on both paths, because it is the thing people get wrong: paying is not the same
          as being cleared to practise. */}
      <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
        <strong className="text-warning">Documents required.</strong> Your signed agreement must
        reach{' '}
        <a href={`mailto:${CONTACT}`} className="text-gold underline underline-offset-4">
          {CONTACT}
        </a>{' '}
        before you can book clients. An active subscription alone doesn&rsquo;t unlock booking.
      </div>

      {error && <Notice>{error}</Notice>}

      <Button
        block
        variant={choice === 'melanite' && !subscriptionActive ? 'outline' : 'gold'}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await saveDirectorChoice(choice)
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Saving…' : 'Continue to services'}
      </Button>
    </div>
  )
}
