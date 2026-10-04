'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { groupByCategory } from '@/lib/service-groups'

import { createBooking, type BookState } from './actions'
import { MonthCalendar, type DayView } from './month-calendar'

export interface SlotView {
  startTime: string
  available: boolean
  reason?: 'taken' | 'past' | 'after-hours' | 'training'
}

export interface ServiceView {
  providerServiceId: string
  category: string | null
  name: string
  durationMins: number
  /** What Melanite charges for the slot, in cents. Null means no published fee, which is a
   *  refusal rather than a free session — the form blocks it the same way the action does. */
  rentalFeeCents: number | null
  /** Which rental tier it falls in, for matching against a pack the provider is holding. */
  tierKey: string | null
}

export interface PackView {
  tierKey: string
  label: string
  sessionsRemaining: number
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Built from the date parts as UTC, not parsed as an instant — `new Date('2026-07-27')` is
 *  midnight UTC, which is the 26th in Denver. */
const dayHeading = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function SubmitButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" block disabled={disabled || pending}>
      {pending ? 'Booking…' : label}
    </Button>
  )
}

/** Reserving the laser.
 *
 *  This used to be a client-booking form: who is coming, what they are paying, how they are
 *  paying it. None of that is Melanite's business any more — the provider bills their own
 *  client on their own system — so the form asks only what the platform actually needs: which
 *  service, when, and anything the provider wants recorded against the slot.
 *
 *  What replaced the price section is the one thing the provider needs to agree to before
 *  pressing the button: the rental fee comes off their card the moment they book, and a decline
 *  means no booking. Showing it at the point of commitment is the difference between a fee and
 *  a surprise.
 */
export function BookForm({
  services,
  slots,
  selectedServiceId,
  onServiceChange,
  onDateChange,
  onMonthChange,
  date,
  month,
  today,
  days,
  packs,
  payingRent,
  cardLast4,
  termsAccepted,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  onServiceChange: (id: string) => void
  onDateChange: (date: string) => void
  onMonthChange: (month: string) => void
  date: string
  month: string
  today: string
  days: DayView[]
  packs: PackView[]
  payingRent: boolean
  cardLast4: string | null
  termsAccepted: boolean
}) {
  const [state, formAction] = useActionState<BookState, FormData>(createBooking, {})
  const [selectedSlot, setSelectedSlot] = useState<string>('')

  const service = services.find((s) => s.providerServiceId === selectedServiceId)
  const openSlots = slots.filter((s) => s.available)

  // A pack in the same tier covers this booking, and the one with sessions left is spent first.
  const pack = service?.tierKey
    ? packs.find((p) => p.tierKey === service.tierKey && p.sessionsRemaining > 0)
    : undefined

  const unpriced = payingRent && service?.rentalFeeCents === null
  const needsCard = payingRent && !pack && !cardLast4
  // A pack does NOT excuse this one. The terms cover what the fee schedule is and what happens
  // on a no-show, which apply just as much to a session drawn from a pack.
  const needsTerms = payingRent && !termsAccepted

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="providerServiceId" value={selectedServiceId} />
      <input type="hidden" name="startTime" value={selectedSlot} />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Service</h2>
        <select
          value={selectedServiceId}
          onChange={(e) => {
            onServiceChange(e.target.value)
            setSelectedSlot('')
          }}
          aria-label="Service"
          className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          {groupByCategory(services).map((group) => {
            const options = group.items.map((s) => (
              <option key={s.providerServiceId} value={s.providerServiceId}>
                {s.name} · {s.durationMins} min
                {s.rentalFeeCents !== null ? ` · ${usd(s.rentalFeeCents)} rental` : ' · no fee set'}
              </option>
            ))
            return group.category ? (
              <optgroup key={group.category} label={group.category}>
                {options}
              </optgroup>
            ) : (
              options
            )
          })}
        </select>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Date &amp; time</h2>

        <MonthCalendar
          month={month}
          days={days}
          selected={date}
          today={today}
          onSelect={(d) => {
            onDateChange(d)
            setSelectedSlot('')
          }}
          onMonthChange={onMonthChange}
        />

        <p className="text-xs text-ink-faint">
          {dayHeading(date)} · {openSlots.length}{' '}
          {openSlots.length === 1 ? 'opening' : 'openings'} for a {service?.durationMins}-minute
          appointment
        </p>

        {openSlots.length === 0 ? (
          <p className="rounded-field border border-dashed border-line px-3 py-6 text-center text-sm text-ink-muted">
            No open slots on this date for a {service?.durationMins}-minute appointment.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {slots.map((slot) => (
              <button
                key={slot.startTime}
                type="button"
                disabled={!slot.available}
                onClick={() => setSelectedSlot(slot.startTime)}
                // The laser is shared, so an unavailable slot is usually someone else's
                // booking rather than anything about this provider. Saying so avoids the
                // "why can't I book?" support message.
                title={
                  slot.reason === 'taken'
                    ? 'Already booked — the laser is shared between providers'
                    : slot.reason === 'training'
                      ? 'Melanite is running a training course that day'
                      : slot.reason === 'past'
                        ? 'Already passed'
                        : slot.reason === 'after-hours'
                          ? 'Would run past closing'
                          : undefined
                }
                className={cn(
                  'rounded-field border px-2 py-2 text-xs tabular-nums transition-colors',
                  selectedSlot === slot.startTime
                    ? 'border-gold bg-gold text-gold-ink'
                    : slot.available
                      ? 'border-line text-ink-secondary hover:border-gold hover:text-gold'
                      : 'cursor-not-allowed border-line/50 text-ink-faint/50 line-through',
                )}
              >
                {time(slot.startTime)}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Your notes
        </h2>
        {/* The only two things left that are about the appointment rather than the equipment.
            Both are the provider's own record — Melanite does not read them and there is no
            client here to attach them to. */}
        <Field
          id="treatmentArea"
          name="treatmentArea"
          label="Treatment area"
          hint="Optional — e.g. underarms, lower back"
        />
        <Field id="notes" name="notes" label="Notes" hint="Optional, visible only to you" />
      </section>

      {payingRent && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Equipment rental
          </h2>

          {unpriced ? (
            // The loud gap. A service with no published fee is blocked rather than booked free.
            <Notice>
              {service?.name} doesn’t have a rental fee set yet, so it can’t be booked. Ask Keoni
              to price it.
            </Notice>
          ) : needsTerms ? (
            <Notice>
              The rental terms have changed since you last accepted them.{' '}
              <Link href="/app/account" className="underline underline-offset-4">
                Review and accept them
              </Link>{' '}
              to carry on booking.
            </Notice>
          ) : pack ? (
            <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
              <strong className="text-ink">Covered by a credited session.</strong>{' '}
              {pack.sessionsRemaining} {pack.sessionsRemaining === 1 ? 'session' : 'sessions'} left
              on {pack.label}. Nothing will be charged to your card.
            </div>
          ) : needsCard ? (
            <Notice>
              Add a card before booking — the rental fee is charged when you reserve the laser.{' '}
              <Link href="/app/account" className="underline underline-offset-4">
                Add one now
              </Link>
              .
            </Notice>
          ) : (
            <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
              <strong className="text-ink">
                {service?.rentalFeeCents !== null && service?.rentalFeeCents !== undefined
                  ? usd(service.rentalFeeCents)
                  : ''}{' '}
                charged now
              </strong>{' '}
              to the card ending {cardLast4}, for the equipment and the room. What you charge your
              client is between you and them.
              <br />
              If the card is declined the slot isn’t held — the laser is shared, so an unpaid
              reservation would take the time away from everyone else for nothing.
            </div>
          )}
        </section>
      )}

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton
        disabled={!selectedSlot || unpriced || needsCard || needsTerms}
        label={
          !payingRent || pack
            ? 'Book appointment'
            : service?.rentalFeeCents
              ? `Book and pay ${usd(service.rentalFeeCents)}`
              : 'Book appointment'
        }
      />
    </form>
  )
}
