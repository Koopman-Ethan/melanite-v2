'use client'

import Link from 'next/link'
import { useActionState, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'

import { acceptRentalTerms } from '@/app/app/account/billing-actions'
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
  serviceId: string
  category: string | null
  name: string
  /** What this provider took last time, or the catalogue's suggestion. */
  durationMins: number
  minDurationMins: number
  maxDurationMins: number
  /** What Melanite charges for the slot, in cents. Null means no published fee, which is a
   *  refusal rather than a free session — the form blocks it the same way the action does. */
  rentalFeeCents: number | null
  /** What the slot would have cost without a promotion, in cents. Null when none is running
   *  on this service for the selected day — so its presence IS "there is a promotion", and
   *  the saving can be shown rather than only a smaller number. */
  rentalWasCents: number | null
  /** "25% off · October promotion", ready to print. Null alongside `rentalWasCents`. */
  promotion: string | null
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
  durationMins,
  onServiceChange,
  onDurationChange,
  onDateChange,
  onMonthChange,
  date,
  month,
  today,
  days,
  packs,
  payingRent,
  quotesNoFee = false,
  cardLast4,
  hasCard,
  termsAccepted,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  /** How long this booking will take. Decides which slots fit, so changing it re-asks the
   *  server rather than filtering what is already on screen. */
  durationMins: number
  onServiceChange: (id: string) => void
  onDurationChange: (mins: number) => void
  onDateChange: (date: string) => void
  onMonthChange: (month: string) => void
  date: string
  month: string
  today: string
  days: DayView[]
  packs: PackView[]
  payingRent: boolean
  /** Melanite derives no fee for this provider — Keoni sets it from their receipt afterwards.
   *
   *  Distinct from a service with no published price, which is a gap and blocks the booking.
   *  This is a permanent property of their arrangement, so a missing figure here is correct
   *  and must NOT read as a fault or stop them booking. */
  quotesNoFee?: boolean
  cardLast4: string | null
  /** Whether anything can be charged at all. `cardLast4` is for display and can be null even
   *  when a payment method exists. */
  hasCard: boolean
  termsAccepted: boolean
}) {
  const [state, formAction] = useActionState<BookState, FormData>(createBooking, {})
  const [selectedSlot, setSelectedSlot] = useState<string>('')
  const [accepting, startAccepting] = useTransition()
  const [acceptError, setAcceptError] = useState<string | null>(null)
  // Accepting revalidates the page, but the re-render arrives a beat later. Tracking it locally
  // means the form unblocks the instant they tap rather than appearing not to have worked.
  const [acceptedNow, setAcceptedNow] = useState(false)

  const service = services.find((s) => s.serviceId === selectedServiceId)
  const openSlots = slots.filter((s) => s.available)

  // A pack in the same tier covers this booking, and the one with sessions left is spent first.
  const pack = service?.tierKey
    ? packs.find((p) => p.tierKey === service.tierKey && p.sessionsRemaining > 0)
    : undefined

  // A service Melanite prices and has not priced. NOT the same as a provider Melanite never
  // prices for — hence `quotesNoFee`, without which the three would be blocked from booking
  // anything at all, because every service looks unpriced to them by design.
  const unpriced = payingRent && !quotesNoFee && service?.rentalFeeCents === null
  const needsCard = payingRent && !pack && !hasCard
  // A credited session does NOT excuse this one. The terms cover what the fee schedule is and
  // what happens on a no-show, which apply just as much to a session that costs nothing.
  const needsTerms = payingRent && !termsAccepted && !acceptedNow

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="serviceId" value={selectedServiceId} />
      <input type="hidden" name="durationMins" value={durationMins} />
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
              <option key={s.serviceId} value={s.serviceId}>
                {s.name}
                {/* A bare "was" price cannot be struck through inside an <option> — the
                    browser renders only text — so the saving is stated in words instead. */}
                {quotesNoFee
                  ? ''
                  : s.rentalFeeCents !== null
                    ? s.rentalWasCents !== null
                      ? ` · ${usd(s.rentalFeeCents)} rental (was ${usd(s.rentalWasCents)})`
                      : ` · ${usd(s.rentalFeeCents)} rental`
                    : ' · no fee set'}
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

        {service && service.minDurationMins !== service.maxDurationMins && (
          <label className="block text-xs">
            <span className="block text-ink-faint">
              How long do you need? Remembered for next time.
            </span>
            <select
              value={durationMins}
              onChange={(e) => onDurationChange(Number(e.target.value))}
              className="mt-1 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {/* Every 15-minute step the service allows. The stride matches the booking grid,
                  so a length that cannot line up with a slot is never offered. */}
              {Array.from(
                { length: Math.floor((service.maxDurationMins - service.minDurationMins) / 15) + 1 },
                (_, i) => service.minDurationMins + i * 15,
              ).map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </label>
        )}
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
            // Accepted HERE rather than by sending them to the account page. A price change
            // blocks every provider from booking until they accept it, which is correct —
            // nobody should be charged a price they have not agreed to — but only tolerable if
            // agreeing takes a tap. Sending somebody away mid-booking to find a settings page
            // turns a correct rule into a support message.
            <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-ink-secondary">
              <strong className="text-warning">The rental prices have changed.</strong>{' '}
              {service?.rentalFeeCents !== null && service?.rentalFeeCents !== undefined && (
                <>
                  {service.name} is now {usd(service.rentalFeeCents)} a session.{' '}
                </>
              )}
              <Link href="/app/account" className="underline underline-offset-4">
                See the full schedule
              </Link>
              .
              {/* On its own line. An inline-flex button inside a paragraph wraps into the
                  middle of the sentence it belongs to — this one landed between "See the full"
                  and "schedule". */}
              <div className="mt-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={accepting}
                  onClick={() =>
                    startAccepting(async () => {
                      const result = await acceptRentalTerms()
                      if (result.error) setAcceptError(result.error)
                      else setAcceptedNow(true)
                    })
                  }
                >
                  {accepting ? 'Accepting…' : 'Accept and carry on'}
                </Button>
              </div>
              {acceptError && <p className="mt-2 text-danger">{acceptError}</p>}
            </div>
          ) : pack ? (
            <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
              <strong className="text-ink">Covered by a credited session.</strong>{' '}
              {pack.sessionsRemaining} {pack.sessionsRemaining === 1 ? 'session' : 'sessions'} left
              on {pack.label}. Nothing will be charged to your card.
            </div>
          ) : needsCard ? (
            <Notice>
              Add a card before booking — the rental fee is charged after your session.{' '}
              <Link href="/app/account" className="underline underline-offset-4">
                Add one now
              </Link>
              .
            </Notice>
          ) : (
            <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
              {quotesNoFee ? (
                <>
                  <strong className="text-ink">Keoni sets the fee for this one</strong> — send her
                  the receipt for what you charged your client and she works it out from that.
                  Nothing is taken from{' '}
                  {cardLast4 ? `the card ending ${cardLast4}` : 'your card'} until she has.
                  <br />
                </>
              ) : (
                <>
                  <strong className="text-ink">
                    {service?.rentalFeeCents !== null && service?.rentalFeeCents !== undefined
                      ? usd(service.rentalFeeCents)
                      : ''}{' '}
                    after your session
                  </strong>{' '}
                  {/* THE PROMOTION, where the figure is, rather than as a banner at the top of
                      the page. A reduction nobody notices changes nobody's mind about booking,
                      and the moment it is worth knowing is while reading the price. */}
                  {service?.rentalWasCents !== null && service?.rentalWasCents !== undefined && (
                    <span className="text-gold">
                      (was <s>{usd(service.rentalWasCents)}</s> — {service.promotion}){' '}
                    </span>
                  )}
                  — taken from{' '}
                  {cardLast4 ? `the card ending ${cardLast4}` : 'your payment method on file'} about
                  twelve hours after it ends, for the equipment and the room. That figure includes
                  card processing, so it is what will appear on your statement. Nothing is charged
                  now, and what you charge your client is between you and them.
                  <br />
                </>
              )}
              {/* Replaces "if the card is declined the slot isn't held", which was true while the
                  fee was taken up front and is now the opposite of what happens. The twelve hours
                  is the same window the close-out form stays open — tell Melanite inside it and
                  nothing is taken until Keoni has read why. */}
              If the session doesn’t go ahead, cancel it or mark it a no-show within that window
              and say what happened — nothing is charged until Melanite has read it.
            </div>
          )}
        </section>
      )}

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton
        disabled={!selectedSlot || unpriced || needsCard || needsTerms}
        label={
          !payingRent || pack || quotesNoFee
            ? 'Book appointment'
            : service?.rentalFeeCents
              ? `Book — ${usd(service.rentalFeeCents)} after the session`
              : 'Book appointment'
        }
      />
    </form>
  )
}
