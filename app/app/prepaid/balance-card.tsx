'use client'

import { useState } from 'react'

import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { BookFromBalance, type BookableForPrepaid } from './book-from-balance'

// One client's prepaid money, with a way to spend it.
//
// A client component only so the booking form can open and close, and so the confirmation
// outlives the form that produced it — a form that unmounts on success takes its own message
// with it, and the provider is left looking at a screen that says nothing happened.
//
// Balances are grouped by CLIENT rather than listed one row per purchase. The provider's
// question is "how much has she got", and two purchases are one pot of money to everybody
// except the allocation order.

export interface ClientBalances {
  clientId: string
  clientName: string
  clientEmail: string | null
  spendableCents: number
  purchases: Array<{
    id: string
    originalAmount: string
    remainingAmount: string
    purchasedAt: Date | null
    status: 'active' | 'exhausted'
    purchaserName: string | null
  }>
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const date = (d: Date | null) =>
  d
    ? new Date(d).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Denver',
      })
    : null

export function BalanceCard({
  balances,
  services,
}: {
  balances: ClientBalances
  services: BookableForPrepaid[]
}) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const spendable = balances.spendableCents > 0

  return (
    <li className="rounded-card border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium">{balances.clientName}</h3>
          {balances.clientEmail && (
            <p className="text-xs text-ink-faint">{balances.clientEmail}</p>
          )}
        </div>

        <div className="flex items-center gap-3 text-right">
          <div>
            <div
              className={cn(
                'text-lg font-semibold tabular-nums',
                spendable ? 'text-success' : 'text-ink-faint',
              )}
            >
              {usd(balances.spendableCents / 100)}
            </div>
            <div className="text-xs text-ink-faint">
              {spendable ? 'available' : 'all used'}
            </div>
          </div>

          {spendable && services.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="rounded-field border border-line-control px-2.5 py-1 text-xs text-ink hover:border-gold"
            >
              {open ? 'Close' : 'Book'}
            </button>
          )}
        </div>
      </div>

      {done && (
        <div className="mt-3">
          <Notice tone="success">{done}</Notice>
        </div>
      )}

      {/* Each purchase kept visible rather than collapsed into the total. With no expiry the
          purchase date is the only date these rows have, and it decides spend order. */}
      <ul className="mt-3 space-y-1 text-xs text-ink-faint">
        {balances.purchases.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {date(p.purchasedAt) ?? 'unpaid'}
              {p.purchaserName ? ` · gift from ${p.purchaserName}` : ''}
            </span>
            <span className="tabular-nums">
              {usd(p.remainingAmount)} left of {usd(p.originalAmount)}
            </span>
          </li>
        ))}
      </ul>

      {open && (
        <BookFromBalance
          clientId={balances.clientId}
          clientName={balances.clientName}
          spendableCents={balances.spendableCents}
          services={services}
          onDone={(success) => {
            setOpen(false)
            if (success) setDone(success)
          }}
        />
      )}

      {spendable && services.length === 0 && (
        <p className="mt-3 text-xs text-warning">
          You have no active services, so this balance cannot be booked against yet. Add one
          under My Services — the money is still theirs.
        </p>
      )}
    </li>
  )
}
