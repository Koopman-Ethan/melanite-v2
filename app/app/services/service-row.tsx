'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

import { updateProviderService, type ServiceActionState } from './actions'

export interface ServiceRowData {
  id: string
  name: string
  description: string | null
  price: string
  durationMins: number
  isActive: boolean
  minDurationMins: number
  maxDurationMins: number
  suggestedDurationMins: number
  offeredPlatformWide: boolean
  packageEligible: boolean
  advancedTierRequired: boolean
  upcomingBookings: number
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export function ServiceRow({ service }: { service: ServiceRowData }) {
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<ServiceActionState>({})

  const [price, setPrice] = useState(Number(service.price))
  const [duration, setDuration] = useState(service.durationMins)

  const save = (isActive: boolean) => {
    startTransition(async () => {
      const result = await updateProviderService(service.id, {
        price,
        durationMins: duration,
        isActive,
      })
      setState(result)
      if (!result.error) setEditing(false)
    })
  }

  const retired = !service.offeredPlatformWide

  return (
    <li
      className={cn(
        // Recessed by BACKGROUND, not by opacity. `opacity-70` here multiplied through every
        // child, and the 10px badges inside landed at 2.95:1 — axe caught it the first time a
        // service was actually retired, which is to say the first time this branch rendered
        // with real content. The badge, the explanation and the absent buttons are what say
        // "retired"; the tint only has to make the card recede.
        'rounded-card border p-5',
        retired ? 'border-line/60 bg-canvas' : 'border-line bg-surface',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{service.name}</h3>
            {retired ? (
              <span className="rounded border border-line-strong bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                retired by Melanite
              </span>
            ) : !service.isActive ? (
              <span className="rounded border border-line-strong bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                off
              </span>
            ) : null}
            {service.advancedTierRequired && (
              <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">
                advanced training
              </span>
            )}
            {service.packageEligible && (
              <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold">
                package eligible
              </span>
            )}
          </div>
          {service.description && (
            <p className="mt-1 text-sm text-ink-muted">{service.description}</p>
          )}
          {!editing && (
            <p className="mt-1.5 text-sm tabular-nums text-ink-secondary">
              {usd(service.price)} · {service.durationMins} min
            </p>
          )}
        </div>

        {!editing && !retired && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => save(!service.isActive)}
            >
              {service.isActive ? 'Turn off' : 'Turn on'}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3 rounded-field border border-line bg-overlay p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="block font-medium text-ink-secondary">Your price</span>
              <input
                type="number"
                min={1}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
                className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="block font-medium text-ink-secondary">Duration (minutes)</span>
              <input
                type="number"
                min={service.minDurationMins}
                max={service.maxDurationMins}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <span className="block text-xs text-ink-faint">
                {service.minDurationMins}–{service.maxDurationMins} min allowed ·{' '}
                {service.suggestedDurationMins} suggested
              </span>
            </label>
          </div>

          {/* Deactivating does not cancel anything already booked — worth saying before the
              click rather than after. */}
          {service.isActive && service.upcomingBookings > 0 && (
            <p className="text-xs text-ink-faint">
              {service.upcomingBookings} upcoming{' '}
              {service.upcomingBookings === 1 ? 'appointment uses' : 'appointments use'} this
              service. Turning it off stops new bookings; it doesn&rsquo;t cancel those.
            </p>
          )}

          {state.error && <p className="text-xs text-danger">{state.error}</p>}

          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => save(service.isActive)}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setPrice(Number(service.price))
                setDuration(service.durationMins)
                setState({})
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!editing && state.error && <p className="mt-2 text-xs text-danger">{state.error}</p>}
      {retired && (
        <p className="mt-2 text-xs text-ink-faint">
          Melanite no longer offers this platform-wide, so it can&rsquo;t be booked. Your past
          appointments and earnings for it are unaffected.
        </p>
      )}
    </li>
  )
}
