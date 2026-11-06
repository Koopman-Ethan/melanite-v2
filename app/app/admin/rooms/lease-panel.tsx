'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import type { LeaseView, TenantOption } from '@/lib/db/queries/rooms'

import {
  decideDepositAction,
  endLeaseNowAction,
  recordNoticeAction,
  startLeaseAction,
} from './actions'

// What Keoni does with one monthly space: start a lease, record notice, end it, and decide the
// deposit. Each action is a Stripe call, so each one is a button press with its outcome said
// back, never an automatic side effect of something else.

const input = 'mt-1 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink'

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dateLabel = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function useOutcome() {
  const [outcome, setOutcome] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [pending, start] = useTransition()
  const run = (fn: () => Promise<{ ok: true; detail: string } | { error: string }>) =>
    start(async () => {
      const result = await fn()
      setOutcome('error' in result ? { tone: 'error', text: result.error } : { tone: 'success', text: result.detail })
    })
  return { outcome, pending, run }
}

export function StartLease({
  roomId,
  monthlyCents,
  tenants,
  today,
}: {
  roomId: string
  monthlyCents: number
  tenants: TenantOption[]
  today: string
}) {
  const [open, setOpen] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [startsOn, setStartsOn] = useState(today)
  const [deposit, setDeposit] = useState((monthlyCents / 100).toFixed(2))
  const [heldOutside, setHeldOutside] = useState(false)
  const { outcome, pending, run } = useOutcome()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-gold underline underline-offset-2"
      >
        Start a lease
      </button>
    )
  }

  const chosen = tenants.find((t) => t.id === providerId)

  return (
    <div className="space-y-3">
      {tenants.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Nobody to let it to yet. Invite them as a <strong>room tenant</strong> from Tools first.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="block text-ink-faint">Tenant</span>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={input}>
              <option value="">Choose…</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.hasCard ? '' : ' (no card yet)'}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="block text-ink-faint">Starts</span>
            <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={input} />
          </label>
          <label className="text-xs">
            <span className="block text-ink-faint">Deposit ($)</span>
            <input
              inputMode="decimal"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              className={`${input} w-28`}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs text-ink-muted">
            <input type="checkbox" checked={heldOutside} onChange={(e) => setHeldOutside(e.target.checked)} />
            I already hold the deposit
          </label>
        </div>
      )}

      {/* Said before the press: this charges a card. */}
      <p className="text-xs text-ink-faint">
        Rent is {usd(monthlyCents)} a month plus card processing, taken on the 1st. A start this
        month charges the part-month now; a start on a later 1st charges nothing until then.
        {heldOutside ? ' No deposit will be charged.' : ' The deposit is charged to their card now.'}
      </p>

      {chosen && !chosen.hasCard && (
        <Notice tone="warning">
          {chosen.name} has no card on file. They add one on their Room Rental page.
        </Notice>
      )}
      {outcome && <Notice tone={outcome.tone}>{outcome.text}</Notice>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !providerId || !chosen?.hasCard}
          onClick={() =>
            run(() => startLeaseAction({ providerId, roomId, startsOn, deposit, depositHeldOutside: heldOutside }))
          }
        >
          {pending ? 'Setting up…' : 'Start lease and charge'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function RunningLease({ lease, today }: { lease: LeaseView; today: string }) {
  const [noticeOn, setNoticeOn] = useState(today)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const { outcome, pending, run } = useOutcome()

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{lease.tenantName}</span>
        {lease.status === 'past_due' ? (
          <span className="rounded-field border border-danger/40 bg-danger/10 px-2 py-0.5 text-[11px] text-danger">
            Rent declined
            {lease.pastDueSince &&
              ` ${lease.pastDueSince.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Denver' })}`}
          </span>
        ) : lease.startsOn > today ? (
          <span className="text-xs text-ink-muted">Starts {dateLabel(lease.startsOn)}</span>
        ) : (
          <span className="text-xs text-ink-muted">Since {dateLabel(lease.startsOn)}</span>
        )}
        {lease.endsOn && <span className="text-xs text-warning">Ends {dateLabel(lease.endsOn)}</span>}
        <span className="text-xs text-ink-faint">
          Deposit {usd(lease.depositCents)}
          {lease.depositStatus === 'held_outside' ? ' (held by you)' : ''}
        </span>
      </div>

      {outcome && <Notice tone={outcome.tone}>{outcome.text}</Notice>}

      <div className="flex flex-wrap items-end gap-3">
        {!lease.endsOn && (
          <>
            <label className="text-xs">
              <span className="block text-ink-faint">Notice given on</span>
              <input type="date" value={noticeOn} onChange={(e) => setNoticeOn(e.target.value)} className={input} />
            </label>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => recordNoticeAction(lease.id, noticeOn))}>
              Record 30 days&rsquo; notice
            </Button>
          </>
        )}
        {/* Two presses. Ending a lease stops the rent at once and is not undone by pressing again. */}
        {confirmEnd ? (
          <>
            <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => endLeaseNowAction(lease.id))}>
              End now — stop the rent
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmEnd(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmEnd(true)}>
            End lease now…
          </Button>
        )}
      </div>
    </div>
  )
}

export function DepositDecision({ lease }: { lease: LeaseView }) {
  const { outcome, pending, run } = useOutcome()
  const outside = lease.depositStatus === 'held_outside'

  return (
    <li className="space-y-2 rounded-card border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm">
          <span className="font-medium">{lease.tenantName}</span> · {lease.roomName}
        </span>
        <span className="text-sm tabular-nums">{usd(lease.depositCents)}</span>
      </div>
      {/* The rule as a suggestion, never as the decision. */}
      <p className="text-xs text-ink-muted">
        {lease.suggestRefund
          ? 'They completed the term and gave notice, so by your rule the deposit goes back.'
          : 'They left before the end of the term (or without notice), so by your rule the deposit is kept.'}
        {outside && ' You hold this deposit yourself — this only records what you decided.'}
      </p>
      {outcome && <Notice tone={outcome.tone}>{outcome.text}</Notice>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={lease.suggestRefund ? 'gold' : 'outline'}
          disabled={pending}
          onClick={() => run(() => decideDepositAction(lease.id, 'refund'))}
        >
          {outside ? 'Mark refunded' : 'Refund deposit'}
        </Button>
        <Button
          size="sm"
          variant={lease.suggestRefund ? 'outline' : 'gold'}
          disabled={pending}
          onClick={() => run(() => decideDepositAction(lease.id, 'keep'))}
        >
          Keep deposit
        </Button>
      </div>
    </li>
  )
}
