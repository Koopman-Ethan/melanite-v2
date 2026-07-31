'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { SUPERVISED_PROCEDURES, requiresMedicalDirection } from '@/lib/room-procedures'

import { saveRoomProcedures } from '../actions'

// What a room renter is asked instead of "Melanite's director or your own".
//
// They are asked what they will PERFORM, not whether they need supervision — the second
// question puts Idaho's rules in their head, where most people will guess, and a "no" is
// unfalsifiable so nothing could be gated on it. The list is the supervised one; anything not
// on it does not require a director, which is why it can be this short.

export function RoomProceduresForm({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial)
  const [none, setNone] = useState(initial.length === 0)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const needsDirector = requiresMedicalDirection(selected)

  const toggle = (key: string) => {
    setNone(false)
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  // "None of these" is a real answer and has to be distinguishable from not having answered.
  // Without it, an empty selection could mean either, and only one of those should let somebody
  // continue.
  const answered = none || selected.length > 0

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          What will you be <span className="text-gold">performing</span>?
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Some procedures need a medical director overseeing them, even in a room you rent.
          Tick anything you plan to do — Melanite works out the rest.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="sr-only">Procedures requiring medical direction</legend>

        {SUPERVISED_PROCEDURES.map((procedure) => {
          const on = selected.includes(procedure.key)
          return (
            <button
              key={procedure.key}
              type="button"
              onClick={() => toggle(procedure.key)}
              aria-pressed={on}
              className={
                'flex w-full items-center gap-3 rounded-field border px-4 py-3 text-left transition-colors ' +
                (on ? 'border-gold bg-gold/10' : 'border-line-control hover:border-line-strong')
              }
            >
              <span
                aria-hidden
                className={
                  'grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ' +
                  (on ? 'border-gold bg-gold text-gold-ink' : 'border-line-control')
                }
              >
                {on ? '✓' : ''}
              </span>
              <span className={on ? 'text-sm text-gold' : 'text-sm text-ink'}>
                {procedure.label}
              </span>
            </button>
          )
        })}

        <button
          type="button"
          onClick={() => {
            setNone(true)
            setSelected([])
          }}
          aria-pressed={none}
          className={
            'flex w-full items-center gap-3 rounded-field border px-4 py-3 text-left transition-colors ' +
            (none ? 'border-gold bg-gold/10' : 'border-line-control hover:border-line-strong')
          }
        >
          <span
            aria-hidden
            className={
              'grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ' +
              (none ? 'border-gold bg-gold text-gold-ink' : 'border-line-control')
            }
          >
            {none ? '✓' : ''}
          </span>
          <span className={none ? 'text-sm text-gold' : 'text-sm text-ink'}>None of these</span>
        </button>
      </fieldset>

      {/* The consequence, before they commit to it — not discovered afterwards on a page that
          will not let them rent the room. */}
      {needsDirector ? (
        <div className="rounded-field border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-ink-secondary">
          <strong className="text-warning">A medical director is required for this.</strong> You
          can finish setting up now, but the room stays unavailable until Melanite has one on
          file for you. Contact Melanite to arrange it.
        </div>
      ) : (
        answered && (
          <p className="rounded-field border border-line p-3 text-xs leading-relaxed text-ink-muted">
            No medical director needed for those. You can book the room as soon as Melanite
            confirms your license.
          </p>
        )
      )}

      {error && <Notice>{error}</Notice>}

      <Button
        block
        disabled={pending || !answered}
        onClick={() =>
          start(async () => {
            const result = await saveRoomProcedures(selected)
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Saving…' : 'Finish setup'}
      </Button>

      {!answered && (
        <p className="text-center text-xs text-ink-faint">
          Choose at least one, or &ldquo;None of these&rdquo;.
        </p>
      )}
    </div>
  )
}
