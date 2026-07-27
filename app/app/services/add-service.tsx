'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'

import { addProviderService, type ServiceActionState } from './actions'

export interface CatalogOption {
  id: string
  name: string
  description: string | null
  suggestedDurationMins: number
  minDurationMins: number
  maxDurationMins: number
  advancedTierRequired: boolean
}

export function AddService({ options }: { options: CatalogOption[] }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<ServiceActionState>({})
  const [serviceId, setServiceId] = useState(options[0]?.id ?? '')
  const [price, setPrice] = useState(0)
  const [duration, setDuration] = useState(options[0]?.suggestedDurationMins ?? 30)

  if (options.length === 0) return null

  const selected = options.find((o) => o.id === serviceId)

  const choose = (id: string) => {
    setServiceId(id)
    const next = options.find((o) => o.id === id)
    // Default to what Melanite suggests for the treatment rather than carrying over the
    // previous selection's duration, which is rarely right for a different service.
    if (next) setDuration(next.suggestedDurationMins)
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Add a service
      </Button>
    )
  }

  return (
    <div className="space-y-3 rounded-card border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">Add a service</h2>

      <label className="block space-y-1.5 text-sm">
        <span className="font-medium text-ink-secondary">Service</span>
        <select
          value={serviceId}
          onChange={(e) => choose(e.target.value)}
          className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      {selected?.description && <p className="text-xs text-ink-muted">{selected.description}</p>}

      {selected?.advancedTierRequired && (
        <p className="rounded-field border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink-secondary">
          This treatment requires advanced training beyond a standard RN/NP/PA licence. Melanite
          may ask for certification before enabling it.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Your price</span>
          <input
            type="number"
            min={1}
            step="0.01"
            value={price || ''}
            onChange={(e) => setPrice(Number(e.target.value))}
            className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Duration (minutes)</span>
          <input
            type="number"
            min={selected?.minDurationMins}
            max={selected?.maxDurationMins}
            step={5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
          />
          {selected && (
            <span className="block text-xs text-ink-faint">
              {selected.minDurationMins}–{selected.maxDurationMins} min allowed
            </span>
          )}
        </label>
      </div>

      {state.error && <p className="text-xs text-danger">{state.error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !serviceId}
          onClick={() =>
            startTransition(async () => {
              const result = await addProviderService({ serviceId, price, durationMins: duration })
              setState(result)
              if (!result.error) {
                setOpen(false)
                setPrice(0)
              }
            })
          }
        >
          {pending ? 'Adding…' : 'Add service'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
