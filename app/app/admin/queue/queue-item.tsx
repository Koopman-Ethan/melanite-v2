'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { useOutcomeLog } from '@/components/ui/outcome-log'
import { cn } from '@/lib/cn'
import type { QueueItem } from '@/lib/db/queries/review-queue'

import {
  confirmSessionRent,
  declineRoomRefund,
  collectOwedRent,
  refundEnrollment,
  waiveOwedRent,
  refundRoomRental,
  skipSessionRent,
  transferEnrollment,
  type QueueState,
} from './actions'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const KIND_LABELS: Record<QueueItem['kind'], string> = {
  room_refund: 'Room refund',
  cancelled_course_deposit: 'Cancelled course',
  // Not "Rent held". Since rent is taken after the session, most of these have had nothing
  // taken — the item is a decision to make, not money sitting somewhere.
  held_rent: 'Rent decision',
  // What she is doing is confirming an amount, not reviewing a problem. "Awaiting" rather than
  // "Needs" because the session already happened and the provider is waiting on her, not the
  // other way round.
  rent_to_confirm: 'Awaiting your figure',
}

const KIND_STYLES: Record<QueueItem['kind'], string> = {
  room_refund: 'border-warning/40 bg-warning/10 text-warning',
  cancelled_course_deposit: 'border-info/40 bg-info/10 text-info',
  // Gold, not a warning colour. Nothing has gone wrong here — a provider cancelled and is
  // waiting to hear, which is the system working. Painting it red beside genuine failures
  // would make the whole queue read as a list of problems and get skimmed.
  held_rent: 'border-gold/40 bg-gold/10 text-gold',
  // Same gold, same reason, and deliberately not a third colour: both are decisions waiting on
  // Keoni rather than failures, and they differ only in what she is deciding.
  rent_to_confirm: 'border-gold/40 bg-gold/10 text-gold',
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
  // Pre-filled with what Melanite worked out, so confirming an accurate figure is one click and
  // only a disagreement costs typing. Initialised once from the item on purpose: a revalidation
  // must not wipe a number she is halfway through correcting.
  const [figure, setFigure] = useState(item.amount)
  const [showPartial, setShowPartial] = useState(false)
  const [target, setTarget] = useState(transferTargets[0]?.id ?? '')
  const [pending, start] = useTransition()

  const record = useOutcomeLog()

  const run = (fn: () => Promise<QueueState>) =>
    start(async () => {
      const result = await fn()
      setShowPartial(false)

      // A SUCCESS IS REPORTED UPWARD, never rendered here. Resolving an item revalidates the
      // queue, the item leaves it, and this component unmounts — taking any confirmation it was
      // showing with it. Keoni saw a green flash too brief to read after charging a provider
      // $57.50, which is money moving on her word with no record that it happened.
      //
      // Errors stay local: the row is still on screen, and the message belongs next to the
      // button that produced it.
      if (result.success) record(result.success)
      else setState(result)
    })

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

        {item.kind === 'held_rent' && (
          <>
            {/* The primary action is now CHARGING, not refunding. Rent is taken after the
                session, so a cancelled one has usually had nothing taken — and the question is
                whether it is owed for, not whether to give it back. */}
            <Button
              size="sm"
              disabled={pending || item.meta.rentTaken === 'yes'}
              onClick={() => run(() => collectOwedRent(item.id))}
            >
              {pending ? 'Working…' : `Charge ${usd(item.amount)}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => waiveOwedRent(item.id))}
            >
              {item.meta.rentTaken === 'yes'
                ? item.meta.heldSession
                  ? 'Give the session back'
                  : `Refund ${usd(item.amount)}`
                : 'Don’t charge it'}
            </Button>
            {/* `self-center` because the row is `items-end` for the room-refund kind, which has
                an input to line up with. A bare sentence bottom-aligned against two buttons
                reads as though it has slipped. */}
            <span className="self-center text-xs text-ink-faint">
              {item.meta.rentTaken === 'yes'
                ? 'Already taken — refunding is the only way back.'
                : 'Nothing taken yet. Either way the provider is emailed the outcome.'}
            </span>
          </>
        )}

        {item.kind === 'rent_to_confirm' && (
          <>
            {/* The amount is EDITABLE here and read-only everywhere else in this queue, because
                this is the one item where the figure itself is the question. Half of a price the
                provider sets is what Melanite believes the session was worth; the receipt they
                send Keoni is what it actually was. */}
            <label className="text-xs">
              <span className="block text-ink-faint">What they charged ÷ 2</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={figure}
                onChange={(e) => setFigure(e.target.value)}
                className="mt-1 w-28 rounded-field border border-line bg-surface px-2 py-1.5 text-xs text-ink tabular-nums"
              />
            </label>

            <Button
              size="sm"
              disabled={pending || !figure || Number(figure) <= 0}
              onClick={() =>
                run(() =>
                  // Null when it is untouched, so accepting the derived figure records no
                  // override — the difference between "she agreed" and "she set it" stays
                  // legible on the booking afterwards.
                  confirmSessionRent(item.id, figure === item.amount ? null : Number(figure)),
                )
              }
            >
              {pending ? 'Charging…' : `Charge ${usd(figure || 0)}`}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => skipSessionRent(item.id))}
            >
              Don’t charge it
            </Button>

            <span className="self-center text-xs text-ink-faint">
              {item.meta.adjusted === 'yes'
                ? 'You have set this figure already — charging uses what is in the box.'
                : item.meta.unpriced === 'yes'
                  ? 'No price on file for this service, so there is nothing to halve. Type half of what the receipt says.'
                  : `They list it at ${usd(item.meta.ownPrice ?? 0)}. Change the figure if the receipt says otherwise.`}
            </span>
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
