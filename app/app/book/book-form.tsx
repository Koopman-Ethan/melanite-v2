'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { createBooking, type BookState } from './actions'

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
  date,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  onServiceChange: (id: string) => void
  onDateChange: (date: string) => void
  date: string
}) {
  const [state, formAction] = useActionState<BookState, FormData>(createBooking, {})
  const [selectedSlot, setSelectedSlot] = useState<string>('')
  const [discount, setDiscount] = useState(0)

  const service = services.find((s) => s.providerServiceId === selectedServiceId)
  const openSlots = slots.filter((s) => s.available)
  const price = service ? Number(service.price) * (1 - discount / 100) : 0

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
        <input
          type="date"
          value={date}
          min={new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())}
          onChange={(e) => {
            onDateChange(e.target.value)
            setSelectedSlot('')
          }}
          aria-label="Date"
          className="rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
        />

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
        <div className="flex items-end gap-3">
          <div className="w-32">
            <Field
              id="discountPct"
              name="discountPct"
              label="Discount %"
              type="number"
              min={0}
              max={99}
              step={1}
              value={discount}
              onChange={(e) => setDiscount(Number(e.target.value) || 0)}
            />
          </div>
          <div className="pb-1">
            <div className="text-2xl font-semibold tabular-nums">{usd(price)}</div>
            {discount > 0 && service && (
              <div className="text-xs text-ink-faint tabular-nums line-through">
                {usd(service.price)}
              </div>
            )}
          </div>
        </div>
      </section>

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton disabled={!selectedSlot} />

      <p className="text-center text-xs text-ink-faint">
        A payment link is created with the booking and expires in 7 days.
      </p>
    </form>
  )
}
