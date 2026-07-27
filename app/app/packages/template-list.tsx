'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'

import { createTemplate, setTemplateActive, updateTemplate, type PackageState } from './actions'

interface Line {
  serviceId: string
  serviceName: string
  quantity: number
  perSessionValue: string
}

interface Template {
  id: string
  name: string
  description: string | null
  totalPrice: string
  expiresAfterDays: number | null
  active: boolean
  soldCount: number
  lines: Line[]
}

interface ServiceOption {
  serviceId: string
  name: string
  price: string
  packageEligible: boolean
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Integer cents, matching the server. Doing this in floats is how a valid package gets
 *  rejected for being 0.0000001 off. */
const cents = (n: number) => Math.round(n * 100)

interface DraftLine {
  serviceId: string
  quantity: number
  perSessionValue: number
}

function Builder({
  services,
  initial,
  onCancel,
  onSubmit,
  pending,
}: {
  services: ServiceOption[]
  initial?: Template
  onCancel: () => void
  onSubmit: (values: {
    name: string
    description: string | null
    totalPrice: number
    expiresAfterDays: number | null
    lines: DraftLine[]
  }) => void
  pending: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [totalPrice, setTotalPrice] = useState(Number(initial?.totalPrice ?? 0))
  const [expiresAfterDays, setExpiresAfterDays] = useState<number | ''>(
    initial?.expiresAfterDays ?? '',
  )
  const [lines, setLines] = useState<DraftLine[]>(
    initial?.lines.map((l) => ({
      serviceId: l.serviceId,
      quantity: l.quantity,
      perSessionValue: Number(l.perSessionValue),
    })) ?? [],
  )

  const sum = lines.reduce((s, l) => s + cents(l.perSessionValue) * l.quantity, 0)
  const target = cents(totalPrice)
  const diff = sum - target
  const balanced = diff === 0 && lines.length > 0

  const unused = services.filter((s) => !lines.some((l) => l.serviceId === s.serviceId))

  return (
    <div className="space-y-4 rounded-card border border-line bg-surface p-5">
      <h3 className="text-sm font-medium">{initial ? 'Edit package' : 'New package'}</h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Full Face — 6 sessions"
            className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-ink-secondary">Total price</span>
          <input
            type="number"
            min={1}
            step="0.01"
            value={totalPrice || ''}
            onChange={(e) => setTotalPrice(Number(e.target.value))}
            className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
          />
        </label>
      </div>

      <label className="block space-y-1.5 text-sm">
        <span className="block font-medium text-ink-secondary">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
        />
      </label>

      <label className="block space-y-1.5 text-sm">
        <span className="block font-medium text-ink-secondary">Expires after (days)</span>
        <input
          type="number"
          min={1}
          value={expiresAfterDays}
          onChange={(e) => setExpiresAfterDays(e.target.value ? Number(e.target.value) : '')}
          placeholder="Leave blank for no expiry"
          className="w-full max-w-48 rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink"
        />
        {/* Q-04 on the backlog: the default is blocked on Idaho gift-certificate law pending
            an attorney. Deliberately no pre-filled number — a guess here becomes policy. */}
        <span className="block text-xs text-ink-faint">
          Melanite hasn&rsquo;t set a standard expiry yet — it&rsquo;s waiting on legal advice.
        </span>
      </label>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-ink-secondary">Sessions included</span>

        {lines.map((line, i) => {
          const svc = services.find((s) => s.serviceId === line.serviceId)
          return (
            <div key={line.serviceId} className="flex flex-wrap items-end gap-2">
              <span className="min-w-32 flex-1 text-sm text-ink-secondary">{svc?.name}</span>
              <label className="text-xs">
                <span className="block text-ink-faint">Qty</span>
                <input
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, j) =>
                        j === i ? { ...l, quantity: Number(e.target.value) || 1 } : l,
                      ),
                    )
                  }
                  className="w-16 rounded-field border border-line bg-overlay px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <label className="text-xs">
                <span className="block text-ink-faint">Per session</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={line.perSessionValue || ''}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, j) =>
                        j === i ? { ...l, perSessionValue: Number(e.target.value) } : l,
                      ),
                    )
                  }
                  className="w-24 rounded-field border border-line bg-overlay px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <button
                type="button"
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
                className="px-2 py-1.5 text-xs text-ink-faint hover:text-danger"
              >
                Remove
              </button>
            </div>
          )
        })}

        {unused.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const svc = services.find((s) => s.serviceId === e.target.value)
              if (!svc) return
              // Seed the per-session value from the provider's own price — the common case is
              // a discount off it, so starting there is less typing than starting from zero.
              setLines([
                ...lines,
                { serviceId: svc.serviceId, quantity: 1, perSessionValue: Number(svc.price) },
              ])
            }}
            className="rounded-field border border-line bg-overlay px-3 py-2 text-sm text-ink-muted"
          >
            <option value="">+ Add a service…</option>
            {unused.map((s) => (
              <option key={s.serviceId} value={s.serviceId}>
                {s.name} ({usd(s.price)})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Live sum, so TOTAL_MISMATCH is nearly unreachable. v1's kickoff asks for exactly this
          — validate as they type, but still render the server's error if it comes back. */}
      <div
        className={cn(
          'rounded-field border px-3 py-2 text-sm tabular-nums',
          lines.length === 0
            ? 'border-line text-ink-faint'
            : balanced
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-warning/40 bg-warning/10 text-warning',
        )}
      >
        Lines total {usd(sum / 100)} · package price {usd(totalPrice || 0)}
        {lines.length > 0 &&
          (balanced ? ' — matches' : ` — ${diff > 0 ? 'over' : 'under'} by ${usd(Math.abs(diff) / 100)}`)}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending || !balanced || !name.trim()}
          onClick={() =>
            onSubmit({
              name,
              description: description || null,
              totalPrice,
              expiresAfterDays: expiresAfterDays === '' ? null : expiresAfterDays,
              lines,
            })
          }
        >
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Create package'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function TemplateList({
  templates,
  services,
}: {
  templates: Template[]
  services: ServiceOption[]
}) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<PackageState>({})
  const [mode, setMode] = useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null)

  const run = (fn: () => Promise<PackageState>) =>
    startTransition(async () => {
      const result = await fn()
      setState(result)
      if (!result.error) setMode(null)
    })

  return (
    <div className="space-y-3">
      {state.error && <Notice>{state.error}</Notice>}
      {state.success && <Notice tone="success">{state.success}</Notice>}

      {templates.length === 0 && mode?.kind !== 'new' && (
        <div className="rounded-card border border-dashed border-line p-8 text-center">
          <p className="text-sm text-ink-muted">
            {services.length === 0
              ? 'Add some services before building a package.'
              : 'You don’t offer any packages yet.'}
          </p>
        </div>
      )}

      <ul className="space-y-3">
        {templates.map((t) =>
          mode?.kind === 'edit' && mode.id === t.id ? (
            <li key={t.id}>
              <Builder
                services={services}
                initial={t}
                pending={pending}
                onCancel={() => setMode(null)}
                onSubmit={(v) => run(() => updateTemplate(t.id, v))}
              />
            </li>
          ) : (
            <li
              key={t.id}
              className={cn(
                'rounded-card border bg-surface p-5',
                t.active ? 'border-line' : 'border-line/60 opacity-70',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{t.name}</h3>
                    {!t.active && (
                      <span className="rounded border border-line-strong bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                        retired
                      </span>
                    )}
                  </div>
                  {t.description && (
                    <p className="mt-1 text-sm text-ink-muted">{t.description}</p>
                  )}
                  <ul className="mt-2 space-y-0.5 text-sm text-ink-muted">
                    {t.lines.map((l) => (
                      <li key={l.serviceId} className="tabular-nums">
                        {l.quantity} × {l.serviceName}{' '}
                        <span className="text-ink-faint">@ {usd(l.perSessionValue)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-ink-faint">
                    {t.soldCount === 0
                      ? 'Not sold yet'
                      : `${t.soldCount} sold`}
                    {t.expiresAfterDays && ` · expires ${t.expiresAfterDays} days after purchase`}
                  </p>
                </div>

                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums">{usd(t.totalPrice)}</div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setMode({ kind: 'edit', id: t.id })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => run(() => setTemplateActive(t.id, !t.active))}
                    >
                      {t.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          ),
        )}
      </ul>

      {mode?.kind === 'new' ? (
        <Builder
          services={services}
          pending={pending}
          onCancel={() => setMode(null)}
          onSubmit={(v) => run(() => createTemplate(v))}
        />
      ) : (
        services.length > 0 &&
        mode === null && (
          <Button variant="outline" onClick={() => setMode({ kind: 'new' })}>
            Build a package
          </Button>
        )
      )}
    </div>
  )
}
