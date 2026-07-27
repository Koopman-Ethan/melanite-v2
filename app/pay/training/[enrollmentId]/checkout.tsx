'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { payTrainingBalance } from '../../../training/actions'
import { CardForm } from '../../card-form'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

export function BalanceCheckout({
  enrollmentId,
  firstName,
  courseDate,
  totalPrice,
  paid,
  owed,
  dueDate,
}: {
  enrollmentId: string
  firstName: string
  courseDate: string
  totalPrice: string
  paid: string
  owed: string
  dueDate: string | null
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [amount, setAmount] = useState(Number(owed))
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, start] = useTransition()

  function begin() {
    setError(null)
    start(async () => {
      const result = await payTrainingBalance(enrollmentId)
      if (result.error) {
        setError(result.error)
        return
      }
      setClientSecret(result.clientSecret ?? null)
      setAmount(result.amount ?? Number(owed))
    })
  }

  if (done) {
    return (
      <div className="mx-auto w-full max-w-lg space-y-4 text-center">
        <div className="rounded-card border border-success/30 bg-success/10 p-8">
          <h1 className="text-xl font-semibold">Paid in full</h1>
          <p className="mt-2 text-sm text-ink-secondary">
            Thank you, {firstName}. Your training on {dayLabel(courseDate)} is fully paid.
          </p>
          <p className="mt-4 text-2xl font-semibold tabular-nums">{usd(amount)}</p>
        </div>
        <p className="text-xs text-ink-faint">
          A receipt has been emailed to you by Stripe. You can close this page.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-5">
      <section className="rounded-card border border-line bg-surface p-5">
        <h1 className="text-lg font-semibold">Your training balance</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Hi {firstName} — laser training on {dayLabel(courseDate)}.
        </p>

        <dl className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">Course total</dt>
            <dd className="tabular-nums">{usd(totalPrice)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">Already paid</dt>
            <dd className="tabular-nums text-success">−{usd(paid)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-2 font-medium">
            <dt>Balance due</dt>
            <dd className="text-xl font-semibold tabular-nums">{usd(owed)}</dd>
          </div>
        </dl>

        {dueDate && (
          <p className="mt-3 text-xs text-warning">
            Due by{' '}
            {new Date(`${dueDate}T12:00:00Z`).toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            })}
            .
          </p>
        )}
      </section>

      {error && <Notice>{error}</Notice>}

      {!clientSecret ? (
        <Button block onClick={begin} disabled={pending}>
          {pending ? 'Preparing…' : `Pay ${usd(owed)}`}
        </Button>
      ) : (
        <section className="space-y-4 rounded-card border border-line bg-surface p-5">
          <CardForm clientSecret={clientSecret} amount={amount} onPaid={() => setDone(true)} />
        </section>
      )}
    </div>
  )
}
