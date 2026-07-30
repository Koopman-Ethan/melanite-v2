'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { bookFromPackage, redemptionSlots, type PackageState } from './actions'

// Booking a session a client has already paid for.
//
// `bookFromPackage` — the most intricate action in the app, with the session claimed
// atomically immediately before the insert so two concurrent redemptions of the last session
// cannot both succeed — was written, tested, and reachable from nothing. A provider could sell
// a package and take the money, and then had no way to deliver it.
//
// The form deliberately does NOT ask which service: a redemption consumes a specific line of a
// specific package, so the line is the thing being booked. Offering a service picker would
// invite choosing one the package does not cover, which the server would then refuse.

export interface RedeemLine {
  itemId: string
  serviceId: string
  serviceName: string
  qtyTotal: number
  qtyUsed: number
  /** Null when the provider no longer offers this service — see the message below. */
  providerServiceId: string | null
}

const todayInDenver = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())

export function RedeemForm({
  clientPackageId,
  line,
  clientName,
  onDone,
}: {
  clientPackageId: string
  line: RedeemLine
  clientName: string
  /** Called with the server's success line, so the confirmation outlives the form that
   *  produced it — closing the form used to take the message with it. */
  onDone: (success?: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<PackageState>({})
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<Array<{ startTime: string; label: string }> | null>(null)
  const [startTime, setStartTime] = useState('')
  const [area, setArea] = useState('')
  const [notes, setNotes] = useState('')

  if (!line.providerServiceId) {
    return (
      <div className="mt-3 rounded-field border border-warning/40 bg-warning/5 p-3">
        <p className="text-xs text-warning">
          You no longer offer {line.serviceName}, so this session cannot be booked. The client has
          already paid for it — add the service back under My Services, or contact Melanite.
        </p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => onDone()}>
          Close
        </Button>
      </div>
    )
  }

  const psId = line.providerServiceId

  const pickDate = (value: string) => {
    setDate(value)
    setStartTime('')
    setSlots(null)
    if (!value) return

    startTransition(async () => {
      const result = await redemptionSlots({ providerServiceId: psId, date: value })
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
      const result = await bookFromPackage({
        clientPackageId,
        itemId: line.itemId,
        providerServiceId: psId,
        startTime,
        treatmentArea: area.trim() || null,
        notes: notes.trim() || null,
      })
      setState(result)
      if (!result.error) onDone(result.success)
    })

  const field = 'w-full rounded-field border border-line-control bg-overlay px-3 py-2 text-sm text-ink'

  return (
    <div className="mt-3 space-y-3 rounded-card border border-line-strong bg-overlay/50 p-4">
      <h4 className="text-sm font-medium">
        Book {line.serviceName} for {clientName}
      </h4>

      {state.error && <Notice>{state.error}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Date</span>
          <input
            type="date"
            value={date}
            min={todayInDenver()}
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

      {/* The rule this whole feature turns on, said where the decision is made. */}
      <p className="text-xs text-ink-faint">
        This uses one of the {line.qtyTotal - line.qtyUsed} sessions left on this package. No
        money moves — the split settled when the client paid.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !startTime} onClick={submit}>
          {pending ? 'Booking…' : 'Book this session'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
