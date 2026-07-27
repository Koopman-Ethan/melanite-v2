'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import type { DayOccupancy, SlotType } from '@/lib/db/queries/room-rental'

import { cancelRoomRental, startRoomRental } from './actions'

export interface RentalView {
  id: string
  rentalDate: string
  slotType: SlotType
  price: string
  status: string
  startAt: string
  hoursOut: number
}

const SLOT_LABELS: Record<SlotType, string> = {
  full: 'Full day',
  am: 'Morning',
  pm: 'Afternoon',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting payment',
  confirmed: 'Confirmed',
  cancellation_requested: 'Cancelled — refund under review',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'border-warning/40 bg-warning/10 text-warning',
  confirmed: 'border-success/40 bg-success/10 text-success',
  cancellation_requested: 'border-warning/40 bg-warning/10 text-warning',
  cancelled: 'border-line-strong bg-overlay text-ink-faint',
  refunded: 'border-info/40 bg-info/10 text-info',
}

/** Which half-days are free, as two marks — not a coloured dot.
 *
 *  WCAG 1.4.1 again: the previous green/amber/blue dot put the whole meaning in hue. A room day
 *  has two bookable halves, so showing them directly is both accessible and more informative
 *  than "part taken" ever was — you can see WHICH half is gone.
 *
 *  `mine` is drawn as an outline rather than another colour, so it survives greyscale too.
 */
function SlotMarks({
  amFree,
  pmFree,
  mine,
  selected,
}: {
  amFree: boolean
  pmFree: boolean
  mine: boolean
  selected: boolean
}) {
  const fill = (free: boolean) =>
    selected
      ? free
        ? 'bg-gold-ink/70'
        : 'bg-gold-ink/20'
      : free
        ? 'bg-success'
        : 'bg-ink-disabled'

  return (
    <span className="mt-1 flex items-center gap-[3px]" aria-hidden>
      <span className={cn('h-[4px] w-[7px] rounded-[1px]', fill(amFree))} />
      <span className={cn('h-[4px] w-[7px] rounded-[1px]', fill(pmFree))} />
      {mine && <span className="ml-[1px] text-[8px] leading-none text-info">●</span>}
    </span>
  )
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

const fullDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function RentalPanel({
  month,
  days,
  today,
  rentals,
  fullDayPrice,
  halfDayPrice,
  amStart,
  amEnd,
  pmEnd,
  onMonthChange,
}: {
  month: string
  days: DayOccupancy[]
  today: string
  rentals: RentalView[]
  fullDayPrice: string
  halfDayPrice: string
  amStart: string
  amEnd: string
  pmEnd: string
  onMonthChange: (month: string) => void
}) {
  const [selectedDate, setSelectedDate] = useState('')
  const [slot, setSlot] = useState<SlotType>('full')
  const [state, setState] = useState<{ error?: string; success?: string }>({})
  const [pending, start] = useTransition()

  const [y, m] = month.split('-').map(Number)
  const leading = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const atFloor = month <= today.slice(0, 7)

  const day = days.find((d) => d.date === selectedDate)
  const price = slot === 'full' ? fullDayPrice : halfDayPrice

  const slotHours: Record<SlotType, string> = {
    full: `${amStart}–${pmEnd}`,
    am: `${amStart}–${amEnd}`,
    pm: `${amEnd}–${pmEnd}`,
  }

  function book() {
    start(async () => {
      const result = await startRoomRental({ rentalDate: selectedDate, slotType: slot })
      if (result.url) {
        window.location.href = result.url
        return
      }
      setState({ error: result.error })
    })
  }

  function cancel(id: string, hoursOut: number) {
    const warning =
      hoursOut <= 24
        ? 'This is within 24 hours. The block is freed immediately, but the refund is at Melanite’s discretion. Cancel it?'
        : 'Cancel this rental and refund it in full?'
    if (!window.confirm(warning)) return

    start(async () => {
      const result = await cancelRoomRental(id)
      setState(result)
    })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="rounded-card border border-line p-3">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => onMonthChange(addMonths(month, -1))}
              disabled={atFloor}
              aria-label="Previous month"
              className="rounded-field px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-overlay hover:text-ink-secondary disabled:cursor-not-allowed disabled:opacity-30"
            >
              ←
            </button>
            <span className="text-sm font-medium">{monthLabel(month)}</span>
            <button
              type="button"
              onClick={() => onMonthChange(addMonths(month, 1))}
              aria-label="Next month"
              className="rounded-field px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-overlay hover:text-ink-secondary"
            >
              →
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((d, i) => (
              <div key={i} className="pb-1 text-center text-[10px] uppercase text-ink-faint">
                {d}
              </div>
            ))}
            {Array.from({ length: leading }, (_, i) => (
              <div key={`pad-${i}`} />
            ))}

            {days.map((d) => {
              const isSelected = d.date === selectedDate
              const isToday = d.date === today
              const none = d.open.length === 0
              const isMine = d.mine.length > 0

              return (
                <button
                  key={d.date}
                  type="button"
                  disabled={none}
                  onClick={() => {
                    setSelectedDate(d.date)
                    // Land on something bookable rather than a block they cannot have.
                    setSlot(d.open.includes('full') ? 'full' : d.open[0])
                    setState({})
                  }}
                  aria-pressed={isSelected}
                  aria-label={`${fullDate(d.date)} — ${
                    d.past
                      ? 'past'
                      : none
                        ? 'fully booked'
                        : `${d.open.map((s) => SLOT_LABELS[s]).join(', ')} available`
                  }`}
                  className={cn(
                    'flex aspect-square flex-col items-center justify-center rounded-field border text-sm tabular-nums transition-colors',
                    isSelected
                      ? 'border-gold bg-gold text-gold-ink'
                      : none
                        ? 'cursor-not-allowed border-transparent text-ink-disabled'
                        : 'border-line text-ink-secondary hover:border-gold hover:text-gold',
                    isToday && !isSelected && 'ring-1 ring-inset ring-line-strong',
                  )}
                >
                  <span className={cn(none && !d.past && 'line-through')}>
                    {Number(d.date.slice(-2))}
                  </span>
                  {!d.past && (
                    <SlotMarks
                      amFree={d.open.includes('am')}
                      pmFree={d.open.includes('pm')}
                      mine={isMine}
                      selected={isSelected}
                    />
                  )}
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
            <span className="flex items-center gap-1">
              <SlotMarks amFree pmFree mine={false} selected={false} /> Morning · afternoon free
            </span>
            <span className="flex items-center gap-1">
              <SlotMarks amFree={false} pmFree mine={false} selected={false} /> One half taken
            </span>
            <span className="flex items-center gap-1">
              <SlotMarks amFree pmFree mine selected={false} /> Yours
            </span>
            <span className="flex items-center gap-1">
              <span className="text-ink-disabled line-through">00</span> Fully booked
            </span>
          </div>
        </div>
      </section>

      {day && (
        <section className="space-y-3 rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">{fullDate(day.date)}</h2>

          <div className="flex flex-wrap gap-1.5">
            {(['full', 'am', 'pm'] as const).map((s) => {
              const available = day.open.includes(s)
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!available}
                  onClick={() => setSlot(s)}
                  aria-pressed={slot === s}
                  className={cn(
                    'rounded-field border px-3 py-2 text-left text-xs transition-colors',
                    slot === s && available
                      ? 'border-gold bg-gold/10 text-gold'
                      : available
                        ? 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary'
                        : 'cursor-not-allowed border-line/40 text-ink-disabled line-through',
                  )}
                >
                  <span className="block font-medium">{SLOT_LABELS[s]}</span>
                  <span className="block text-[10px] tabular-nums opacity-80">{slotHours[s]}</span>
                  <span className="block text-[10px] tabular-nums opacity-80">
                    {usd(s === 'full' ? fullDayPrice : halfDayPrice)}
                  </span>
                </button>
              )
            })}
          </div>

          {day.mine.length > 0 && (
            <p className="text-xs text-info">
              You already have the {day.mine.map((s) => SLOT_LABELS[s].toLowerCase()).join(' and ')}{' '}
              on this date.
            </p>
          )}

          {state.error && <Notice>{state.error}</Notice>}

          <div className="flex items-center justify-between gap-4">
            <span className="text-xl font-semibold tabular-nums">{usd(price)}</span>
            <Button onClick={book} disabled={pending || !day.open.includes(slot)}>
              {pending ? 'Starting…' : 'Pay and reserve'}
            </Button>
          </div>

          <p className="text-xs text-ink-faint">
            The block is held for 30 minutes while you pay. Payment is taken by Stripe — no card
            details reach this app.
          </p>
        </section>
      )}

      {state.success && <Notice tone="success">{state.success}</Notice>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Your rentals</h2>

        {rentals.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            You haven&rsquo;t rented the room yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {rentals.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{fullDate(r.rentalDate)}</span>
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                        STATUS_STYLES[r.status] ?? 'border-line text-ink-muted',
                      )}
                    >
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
                    {SLOT_LABELS[r.slotType]} · {slotHours[r.slotType]} · {usd(r.price)}
                  </p>
                </div>

                {r.status === 'confirmed' && r.hoursOut > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => cancel(r.id, r.hoursOut)}
                  >
                    {r.hoursOut <= 24 ? 'Cancel (no auto-refund)' : 'Cancel and refund'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-ink-faint">
          Cancel more than 24 hours ahead and the refund is automatic. Inside 24 hours the block
          is still freed straight away, but Melanite decides the refund.
        </p>
      </section>
    </div>
  )
}
