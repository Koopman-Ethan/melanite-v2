'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { saveServices } from '../actions'

export interface CatalogService {
  id: string
  name: string
  description: string | null
  suggestedDurationMins: number
  minDurationMins: number
  maxDurationMins: number
}

interface Selection {
  on: boolean
  price: string
  durationMins: string
}

export function ServicesForm({ catalog }: { catalog: CatalogService[] }) {
  const [picks, setPicks] = useState<Record<string, Selection>>(() =>
    Object.fromEntries(
      catalog.map((s) => [
        s.id,
        { on: false, price: '', durationMins: String(s.suggestedDurationMins) },
      ]),
    ),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const chosen = catalog.filter((s) => picks[s.id]?.on)

  const update = (id: string, patch: Partial<Selection>) =>
    setPicks((p) => ({ ...p, [id]: { ...p[id], ...patch } }))

  if (catalog.length === 0) {
    return (
      <div className="mt-6 rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
        No services are set up on the platform yet. Contact Melanite — this needs sorting before
        you can finish.
      </div>
    )
  }

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          Choose your <span className="text-gold">services</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Switch on the treatments you offer and set your own price and session length. You can
          change any of this later from My Services.
        </p>
      </div>

      <ul className="space-y-2">
        {catalog.map((service) => {
          const pick = picks[service.id]
          return (
            <li
              key={service.id}
              className={cn(
                'rounded-card border p-4 transition-colors',
                pick.on ? 'border-gold bg-gold/5' : 'border-line',
              )}
            >
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={pick.on}
                  onChange={(e) => update(service.id, { on: e.target.checked })}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{service.name}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    Suggested {service.suggestedDurationMins} min
                    {service.description && ` · ${service.description}`}
                  </span>
                </span>
              </label>

              {pick.on && (
                <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                  <label className="block space-y-1.5">
                    <span className="block text-xs text-ink-secondary">Your price</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={pick.price}
                      onChange={(e) => update(service.id, { price: e.target.value })}
                      placeholder="0.00"
                      className="min-h-11 w-full rounded-field border border-line-control bg-surface px-3 py-2 text-sm text-ink focus:border-gold"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="block text-xs text-ink-secondary">
                      Session length ({service.minDurationMins}–{service.maxDurationMins} min)
                    </span>
                    <input
                      type="number"
                      min={service.minDurationMins}
                      max={service.maxDurationMins}
                      step={5}
                      value={pick.durationMins}
                      onChange={(e) => update(service.id, { durationMins: e.target.value })}
                      className="min-h-11 w-full rounded-field border border-line-control bg-surface px-3 py-2 text-sm text-ink focus:border-gold"
                    />
                  </label>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {error && <Notice>{error}</Notice>}

      <Button
        block
        disabled={pending || chosen.length === 0}
        onClick={() =>
          start(async () => {
            const result = await saveServices(
              chosen.map((s) => ({
                serviceId: s.id,
                price: Number(picks[s.id].price),
                durationMins: Number(picks[s.id].durationMins),
              })),
            )
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Finishing…' : 'Finish setup'}
      </Button>
    </div>
  )
}
