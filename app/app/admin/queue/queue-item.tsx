'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import type { QueueItem } from '@/lib/db/queries/review-queue'

import {
  declineRoomRefund,
  refundEnrollment,
  refundRoomRental,
  retryFee,
  transferEnrollment,
  waiveFee,
  type QueueState,
} from './actions'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const KIND_LABELS: Record<QueueItem['kind'], string> = {
  room_refund: 'Room refund',
  failed_fee: 'Fee not collected',
  cancelled_course_deposit: 'Cancelled course',
}

const KIND_STYLES: Record<QueueItem['kind'], string> = {
  room_refund: 'border-warning/40 bg-warning/10 text-warning',
  failed_fee: 'border-danger/40 bg-danger/10 text-danger',
  cancelled_course_deposit: 'border-info/40 bg-info/10 text-info',
}

const daysAgo = (days: number) =>
  days <= 0 ? 'since today' : `${days} day${days === 1 ? '' : 's'}`

export interface QueueItemView extends Omit<QueueItem, 'since'> {
  since: string
}

export function QueueRow({
  item,
  transferTargets,
}: {
  item: QueueItemView
  transferTargets: { id: string; day1Date: string }[]
}) {
  const [state, setState] = useState<QueueState>({})
  const [partial, setPartial] = useState('')
  const [showPartial, setShowPartial] = useState(false)
  const [target, setTarget] = useState(transferTargets[0]?.id ?? '')
  const [pending, start] = useTransition()

  const run = (fn: () => Promise<QueueState>) =>
    start(async () => {
      setState(await fn())
      setShowPartial(false)
    })

  // Resolved rows disappear on revalidate, so a success message here is transient by design —
  // it exists to confirm what happened before the row goes.
  if (state.success) {
    return (
      <li className="rounded-card border border-success/30 bg-success/10 p-4 text-sm">
        {state.success}
      </li>
    )
  }

  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                KIND_STYLES[item.kind],
              )}
            >
              {KIND_LABELS[item.kind]}
            </span>
            <span className="text-sm font-medium">{item.who}</span>
            <span className="text-xs text-ink-faint">waiting {daysAgo(item.waitingDays)}</span>
          </div>
          <p className="mt-1.5 text-sm text-ink-secondary">{item.detail}</p>
        </div>

        <div className="text-right text-lg font-semibold tabular-nums">{usd(item.amount)}</div>
      </div>

      {state.error && (
        <div className="mt-3">
          <Notice>{state.error}</Notice>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
        {item.kind === 'room_refund' && (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => refundRoomRental(item.id, null))}
            >
              {pending ? 'Working…' : `Refund ${usd(item.amount)}`}
            </Button>

            {showPartial ? (
              <label className="text-xs">
                <span className="block text-ink-faint">Partial amount</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type="number"
                    min={0}
                    max={Number(item.amount)}
                    step={0.01}
                    value={partial}
                    onChange={(e) => setPartial(e.target.value)}
                    className="w-28 rounded-field border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !partial}
                    onClick={() => run(() => refundRoomRental(item.id, Number(partial)))}
                  >
                    Refund it
                  </Button>
                </div>
              </label>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowPartial(true)}>
                Partial refund
              </Button>
            )}

            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => declineRoomRefund(item.id))}
            >
              No refund
            </Button>
          </>
        )}

        {item.kind === 'failed_fee' && (
          <>
            <Button size="sm" disabled={pending} onClick={() => run(() => retryFee(item.id))}>
              {pending ? 'Trying…' : 'Try the card again'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => waiveFee(item.id))}
            >
              Waive it
            </Button>
          </>
        )}

        {item.kind === 'cancelled_course_deposit' && (
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => refundEnrollment(item.id, null))}
            >
              {pending ? 'Working…' : `Refund ${usd(item.amount)}`}
            </Button>

            {transferTargets.length > 0 ? (
              <div className="flex items-end gap-2">
                <label className="text-xs">
                  <span className="block text-ink-faint">Move to</span>
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="mt-1 rounded-field border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                  >
                    {transferTargets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {new Date(`${t.day1Date}T12:00:00Z`).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          timeZone: 'UTC',
                        })}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !target}
                  onClick={() => run(() => transferEnrollment(item.id, target))}
                >
                  Move them
                </Button>
              </div>
            ) : (
              <span className="text-xs text-ink-faint">
                No scheduled course to move them to — schedule one first.
              </span>
            )}
          </>
        )}
      </div>
    </li>
  )
}
