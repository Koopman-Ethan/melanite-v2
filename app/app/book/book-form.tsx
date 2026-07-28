'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { createBooking, type BookState } from './actions'
import { MonthCalendar, type DayView } from './month-calendar'

export interface SlotView {
  startTime: string
  available: boolean
  reason?: 'taken' | 'past' | 'after-hours'
}

export interface ServiceView {
  providerServiceId: string
  name: string
  price: string
  durationMins: number
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

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

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" block disabled={disabled || pending}>
      {pending ? 'Booking…' : 'Book appointment'}
    </Button>
  )
}

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
}) {
  const [state, formAction] = useActionState<BookState, FormData>(createBooking, {})
  const [selectedSlot, setSelectedSlot] = useState<string>('')
  const [externalMethod, setExternalMethod] = useState<'' | 'groupon' | 'cherry' | 'cash' | 'check' | 'other'>('')
  const [discountType, setDiscountType] = useState<'none' | 'percent' | 'amount'>('none')
  const [discountValue, setDiscountValue] = useState(0)

  const service = services.find((s) => s.providerServiceId === selectedServiceId)
  const openSlots = slots.filter((s) => s.available)
  // Mirrors the server's cents arithmetic so the figure shown is the figure charged.
  const originalCents = service ? Math.round(Number(service.price) * 100) : 0
  const discountCents =
    discountType === 'percent'
      ? Math.round(originalCents * (discountValue / 100))
      : discountType === 'amount'
        ? Math.round(discountValue * 100)
        : 0
  const overDiscounted = discountCents >= originalCents && discountType !== 'none'
  const price = Math.max(originalCents - discountCents, 0) / 100

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
          {services.map((s) => (
            <option key={s.providerServiceId} value={s.providerServiceId}>
              {s.name} — {usd(s.price)} · {s.durationMins} min
            </option>
          ))}
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
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Client</h2>
        <Field id="clientName" name="clientName" label="Name" required />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="clientPhone" name="clientPhone" label="Phone" type="tel" />
          <Field id="clientEmail" name="clientEmail" label="Email" type="email" />
        </div>
        <Field
          id="treatmentArea"
          name="treatmentArea"
          label="Treatment area"
          hint="Optional — e.g. underarms, lower back"
        />
        <Field id="notes" name="notes" label="Notes" hint="Optional, visible only to you" />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Price</h2>

        <input type="hidden" name="discountType" value={discountType} />
        <input type="hidden" name="discountValue" value={discountValue} />

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1.5">
            {(['none', 'percent', 'amount'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setDiscountType(t)
                  if (t === 'none') setDiscountValue(0)
                }}
                aria-pressed={discountType === t}
                className={cn(
                  'rounded-field border px-3 py-2 text-xs transition-colors',
                  discountType === t
                    ? 'border-gold bg-gold/10 text-gold'
                    : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
                )}
              >
                {t === 'none' ? 'No discount' : t === 'percent' ? '% off' : '$ off'}
              </button>
            ))}
          </div>

          {discountType !== 'none' && (
            <label className="text-xs">
              <span className="block text-ink-faint">
                {discountType === 'percent' ? 'Percent' : 'Amount'}
              </span>
              <input
                type="number"
                min={0}
                max={discountType === 'percent' ? 99 : undefined}
                step={discountType === 'percent' ? 1 : 0.01}
                value={discountValue || ''}
                onChange={(e) => setDiscountValue(Number(e.target.value) || 0)}
                className="w-28 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>
          )}

          <div className="pb-1">
            <div className="text-2xl font-semibold tabular-nums">{usd(price)}</div>
            {discountType !== 'none' && discountValue > 0 && service && (
              <div className="text-xs text-ink-faint tabular-nums line-through">
                {usd(service.price)}
              </div>
            )}
          </div>
        </div>

        {/* Refused rather than clamped: a free appointment is a comp, which is a different
            payment source, and silently zeroing the price would hide the mistake. */}
        {overDiscounted && (
          <p className="text-xs text-danger">
            That discount is more than the price. Book it as comped if it&rsquo;s free.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          How is this being paid?
        </h2>

        <input type="hidden" name="externalMethod" value={externalMethod} />

        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['', 'Payment link'],
              ['groupon', 'Groupon'],
              ['cherry', 'Cherry'],
              ['cash', 'Cash'],
              ['check', 'Check'],
              ['other', 'Other'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value || 'link'}
              type="button"
              onClick={() => setExternalMethod(value)}
              aria-pressed={externalMethod === value}
              className={cn(
                'rounded-field border px-3 py-2 text-xs transition-colors',
                externalMethod === value
                  ? 'border-gold bg-gold/10 text-gold'
                  : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {externalMethod === '' ? (
          <p className="text-xs text-ink-faint">
            A checkout link is created and emailed to the client.
          </p>
        ) : (
          // Said plainly, because the consequence is invisible otherwise: no link is created,
          // so nothing is emailed, so nobody can pay twice by accident.
          <div className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-secondary">
            <strong className="text-ink">No payment link.</strong> The client pays outside the
            app, so nothing is emailed. Make sure the price above is what they are actually
            paying — Melanite works out its share from that figure
            {externalMethod === 'groupon' || externalMethod === 'cash' || externalMethod === 'check'
              ? ', and collects it from you rather than paying you out.'
              : '.'}
          </div>
        )}
      </section>

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton disabled={!selectedSlot || overDiscounted} />

      <p className="text-center text-xs text-ink-faint">
        A payment link is created with the booking and expires in 7 days.
      </p>
    </form>
  )
}
