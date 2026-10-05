'use client'

import { useActionState, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { blockLaserTime, unblockLaserTime, type BlockState } from './actions'

export interface BlockView {
  id: string
  /** Already formatted for Denver by the server — a client component has no business guessing
   *  the business timezone from the browser's. */
  when: string
  reason: string | null
  createdByName: string | null
}

/** Common lengths, so the usual case is one tap. "Rest of the day" is deliberately absent —
 *  it depends on closing time, and a wrong guess silently blocks too much. */
const LENGTHS = [30, 60, 90, 120, 180, 240]

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Blocking…' : 'Block this time'}
    </Button>
  )
}

/** Closing laser time, and reopening it.
 *
 *  Lives on the calendar because that is where somebody is standing when they decide to close
 *  an afternoon. Collapsed by default: the page's job is showing the week, and a form that is
 *  always open competes with it.
 */
export function BlockTime({ blocks, today }: { blocks: BlockView[]; today: string }) {
  const [state, formAction] = useActionState<BlockState, FormData>(blockLaserTime, {})
  const [open, setOpen] = useState(false)
  const [removing, startRemoving] = useTransition()
  const [removeError, setRemoveError] = useState<string | null>(null)

  return (
    <section className="rounded-card border border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-medium">Blocked time</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {blocks.length === 0
              ? 'Nothing is blocked. Providers can book any open slot.'
              : `${blocks.length} upcoming ${blocks.length === 1 ? 'window' : 'windows'} nobody can book.`}
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Block off time'}
        </Button>
      </div>

      {open && (
        <form action={formAction} className="space-y-3 border-t border-line p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="block text-ink-faint">Date</span>
              <input
                type="date"
                name="date"
                required
                defaultValue={today}
                min={today}
                className="mt-1 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>

            <label className="text-xs">
              <span className="block text-ink-faint">Starting</span>
              <input
                type="time"
                name="time"
                required
                step={900}
                defaultValue="12:00"
                className="mt-1 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>

            <label className="text-xs">
              <span className="block text-ink-faint">For</span>
              <select
                name="minutes"
                defaultValue="60"
                className="mt-1 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                {LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? '' : 's'}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-xs">
            <span className="block text-ink-faint">Why (optional, only you see this)</span>
            <input
              name="reason"
              placeholder="e.g. servicing, closed for the afternoon"
              className="mt-1 w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>

          <p className="text-xs text-ink-faint">
            Providers see the slot as unavailable, with no reason given. If anything is already
            booked in that window this will refuse and tell you what.
          </p>

          {state.error && <Notice>{state.error}</Notice>}
          {state.success && <Notice tone="success">{state.success}</Notice>}

          <SubmitButton />
        </form>
      )}

      {blocks.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {blocks.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="text-sm tabular-nums">{b.when}</div>
                <div className="text-xs text-ink-faint">
                  {b.reason ?? 'No reason given'}
                  {b.createdByName && ` · ${b.createdByName}`}
                </div>
              </div>
              <Button
                variant="ghost"
                disabled={removing}
                onClick={() =>
                  startRemoving(async () => {
                    const result = await unblockLaserTime(b.id)
                    if (result.error) setRemoveError(result.error)
                  })
                }
              >
                Reopen
              </Button>
            </li>
          ))}
        </ul>
      )}

      {removeError && (
        <div className="border-t border-line p-4">
          <Notice>{removeError}</Notice>
        </div>
      )}
    </section>
  )
}
