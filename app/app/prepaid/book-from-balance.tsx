'use client'

import { useMemo, useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { todayInDenver } from '@/lib/validation'

// The slot lookup is the package one, imported rather than rewritten. It answers "which times
// are free for this service on this date", which has nothing to do with how the appointment is
// paid for — and two implementations of that question is exactly how a calendar ends up
// promising a slot that turns out to be taken.
import { redemptionSlots } from '../packages/actions'
import { bookFromPrepaid, type PrepaidState } from './actions'

export interface BookableForPrepaid {
  providerServiceId: string
  name: string
  category: string | null
  price: string
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Booking an appointment against a client's prepaid balance.
 *
 *  The arithmetic is shown before anything is committed, and that is the point of the screen
 *  rather than a nicety. A balance that does not cover the service leaves a remainder to be
 *  collected on a card, and a provider should never have to work that out in their head with a
 *  client waiting — nor discover it afterwards from an email the client received.
 */
export function BookFromBalance({
  clientId,
  clientName,
  spendableCents,
  services,
  onDone,
}: {
  clientId: string
  clientName: string
  /** Everything this client holds with this provider, across balances. */
  spendableCents: number
  services: BookableForPrepaid[]
  onDone: (success?: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<PrepaidState>({})
  const [providerServiceId, setProviderServiceId] = useState('')
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<Array<{ startTime: string; label: string }> | null>(null)
  const [startTime, setStartTime] = useState('')
  const [area, setArea] = useState('')
  const [notes, setNotes] = useState('')

  const chosen = services.find((s) => s.providerServiceId === providerServiceId)

  const sums = useMemo(() => {
    if (!chosen) return null
    const price = Math.round(Number(chosen.price) * 100)
    const applied = Math.min(spendableCents, price)
    return { price, applied, due: price - applied }
  }, [chosen, spendableCents])

  const grouped = useMemo(() => {
    const map = new Map<string, BookableForPrepaid[]>()
    for (const s of services) {
      const key = s.category ?? 'Other'
      map.set(key, [...(map.get(key) ?? []), s])
    }
    return [...map.entries()]
  }, [services])

  const pickDate = (value: string) => {
    setDate(value)
    setStartTime('')
    setSlots(null)
    if (!value || !providerServiceId) return

    startTransition(async () => {
      const result = await redemptionSlots({ providerServiceId, date: value })
      if (result.error) {
        setState({ error: result.error })
        return
      }
      setState({})
      setSlots(result.slots ?? [])
    })
  }

  const submit = () =>
    startTransition(async () => {
      const result = await bookFromPrepaid({
        clientId,
        providerServiceId,
        startTime,
        treatmentArea: area.trim() || null,
        notes: notes.trim() || null,
      })
      setState(result)
      if (!result.error) onDone(result.success)
    })

  const field =
    'w-full rounded-field border border-line-control bg-overlay px-3 py-2 text-sm text-ink'

  return (
    <div className="mt-3 space-y-3 rounded-card border border-line-strong bg-overlay/50 p-4">
      <h4 className="text-sm font-medium">Book an appointment for {clientName}</h4>

      {state.error && <Notice>{state.error}</Notice>}

      <label className="block space-y-1.5 text-sm">
        <span className="block font-medium text-ink-secondary">Service</span>
        <select
          value={providerServiceId}
          onChange={(e) => {
            setProviderServiceId(e.target.value)
            setDate('')
            setSlots(null)
            setStartTime('')
          }}
          className={field}
        >
          <option value="">Choose a service…</option>
          {/* A lone group renders without a heading — one <optgroup> around everything is
              noise, the same call the service pickers already make. */}
          {grouped.length === 1
            ? grouped[0][1].map((s) => (
                <option key={s.providerServiceId} value={s.providerServiceId}>
                  {s.name} — ${Number(s.price).toFixed(2)}
                </option>
              ))
            : grouped.map(([category, items]) => (
                <optgroup key={category} label={category}>
                  {items.map((s) => (
                    <option key={s.providerServiceId} value={s.providerServiceId}>
                      {s.name} — ${Number(s.price).toFixed(2)}
                    </option>
                  ))}
                </optgroup>
              ))}
        </select>
      </label>

      {sums && (
        <dl className="space-y-1 rounded-field border border-line bg-surface p-3 text-sm tabular-nums">
          <div className="flex justify-between">
            <dt className="text-ink-muted">Service</dt>
            <dd>{usd(sums.price)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">Prepaid applied</dt>
            <dd className="text-success">−{usd(sums.applied)}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-1 font-semibold">
            <dt>Due at the appointment</dt>
            <dd className={sums.due > 0 ? 'text-warning' : ''}>{usd(sums.due)}</dd>
          </div>
        </dl>
      )}

      {sums && sums.due > 0 && (
        <p className="text-xs text-warning">
          Their balance does not cover this. A payment link for the {usd(sums.due)} difference is
          created with the booking and emailed to them.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Date</span>
          <input
            type="date"
            value={date}
            min={todayInDenver()}
            disabled={!providerServiceId}
            onChange={(e) => pickDate(e.target.value)}
            className={field}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Treatment area</span>
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder="Optional"
            className={field}
          />
        </label>
      </div>

      {/* Openings account for every provider, because there is one laser. A time missing here
          is one somebody else already has. */}
      {date && (
        <div className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Time</span>
          {slots === null ? (
            <p className="text-xs text-ink-faint">{pending ? 'Checking the laser…' : ''}</p>
          ) : slots.length === 0 ? (
            <p className="text-xs text-warning">
              Nothing free that day — the laser is booked. Try another date.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button
                  key={s.startTime}
                  type="button"
                  aria-pressed={startTime === s.startTime}
                  onClick={() => setStartTime(s.startTime)}
                  className={
                    'rounded-field border px-3 py-1.5 text-sm ' +
                    (startTime === s.startTime
                      ? 'border-gold bg-gold/15 text-gold'
                      : 'border-line-control bg-overlay text-ink hover:border-gold')
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="block space-y-1.5 text-sm">
        <span className="block font-medium text-ink-secondary">Notes</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional"
          className={field}
        />
      </label>

      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !startTime || !providerServiceId} onClick={submit}>
          {pending ? 'Booking…' : 'Book it'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
