'use client'

import { useActionState, useMemo, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { grossUpForProcessing } from '@/lib/money'
import {
  covers,
  describePromotion,
  discountedCents,
  prettyDay,
  type Promotion,
} from '@/lib/promotions'
import { validatePromotion, type DraftPromotion } from '@/lib/validate/promotion'

import { endPromotion, startPromotion, type PricingState } from './actions'
import type { EntryView } from './form'

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Whole days from today to a date, counting today as the first. */
function daysLeft(endsOn: string, today: string): number {
  const at = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((at(endsOn) - at(today)) / 86_400_000) + 1
}

function StartButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? 'Starting…' : 'Start this promotion'}
    </Button>
  )
}

/**
 * Running a promotion on the rental fee.
 *
 * ITS OWN SECTION UNDER THE SCHEDULE, not a mode of it, because the two do different things
 * to a provider. Publishing a price asks every one of them to accept it before they can book
 * again; a promotion asks nobody, because it can only charge them less than the ceiling they
 * already agreed to. Putting them in one form would hide that difference behind a checkbox.
 *
 * It borrows the schedule form's shape deliberately — a gold panel that reads the change back
 * as "was → now" before anything is committed. Keoni already knows how to read that panel, and
 * money typed into a box should never be committed unread.
 */
export function Promotions({
  running,
  entries,
  today,
  processing,
}: {
  running: Promotion[]
  entries: EntryView[]
  /** Denver's today, from the server — the client's clock may be in another timezone. */
  today: string
  processing: { pct: number; fixedCents: number }
}) {
  const [state, formAction] = useActionState<PricingState, FormData>(startPromotion, {})
  const [ending, startEnding] = useTransition()
  const [endState, setEndState] = useState<PricingState>({})

  const [kind, setKind] = useState<'percent' | 'amount'>('percent')
  const [value, setValue] = useState('')
  const [tierKey, setTierKey] = useState('')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')
  const [name, setName] = useState('')

  const draft: DraftPromotion = useMemo(
    () => ({
      name,
      tierKey: tierKey === '' ? null : tierKey,
      kind,
      // Dollars in the box, cents in the model — converted in one place, as the schedule form
      // does, so the preview and the server cannot disagree about what was typed.
      value: kind === 'percent' ? Math.round(Number(value)) : Math.round(Number(value) * 100),
      startsOn,
      endsOn,
    }),
    [name, tierKey, kind, value, startsOn, endsOn],
  )

  const typed = value.trim() !== '' && Number.isFinite(Number(value))

  /** The same function the action runs. The form refuses before the round trip and the server
   *  refuses again — one set of rules, checked twice, which is the only way they stay the
   *  same rules. */
  const invalid = useMemo(
    () => (typed ? validatePromotion(draft, { today, tiers: entries, existing: running }) : null),
    [draft, typed, today, entries, running],
  )

  /** What it does to every tier it touches, at the fee in force today. */
  const effect = useMemo(() => {
    if (!typed || invalid) return []
    return entries
      .filter((e) => covers({ ...draft, id: '' }, e.tierKey))
      .map((e) => {
        const now = discountedCents(e.singleCents, { ...draft, id: '' })
        const up = (c: number) =>
          grossUpForProcessing({ netCents: c, pct: processing.pct, fixedCents: processing.fixedCents })
            .chargeCents
        return { label: e.label, from: e.singleCents, to: now, charged: up(now) }
      })
  }, [draft, typed, invalid, entries, processing])

  const span = startsOn && endsOn && endsOn >= startsOn ? daysLeft(endsOn, startsOn) : null

  const end = (id: string) =>
    startEnding(async () => setEndState(await endPromotion(id)))

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Promotions</h2>
        <p className="mt-1 text-sm text-ink-muted">
          A temporary reduction on top of the schedule above. Nobody has to accept it — a
          promotion only ever costs a provider <strong className="text-ink-secondary">less</strong>{' '}
          than the prices they already agreed to, so it does not interrupt anyone&rsquo;s booking
          the way publishing a price does.
        </p>
      </header>

      {running.length > 0 && (
        <ul className="space-y-2">
          {running.map((p) => {
            const started = p.startsOn <= today
            const left = daysLeft(p.endsOn, today)
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-gold/40 bg-gold/5 p-4"
              >
                <div className="text-sm">
                  <strong className="text-ink">{describePromotion(p)}</strong>
                  <span className="text-ink-secondary">
                    {' '}
                    on{' '}
                    {p.tierKey === null
                      ? 'everything'
                      : (entries.find((e) => e.tierKey === p.tierKey)?.label ?? p.tierKey)}
                  </span>
                  <span className="text-ink-faint"> · “{p.name}”</span>
                  {/* THE COUNTDOWN IS THE POINT. The failure mode of a hand-run promotion is
                      forgetting it, at which point the promotional price quietly becomes the
                      real one. */}
                  <p className="mt-1 text-xs text-ink-faint tabular-nums">
                    {started
                      ? `Ends ${prettyDay(p.endsOn)} · ${left} day${left === 1 ? '' : 's'} left`
                      : `Starts ${prettyDay(p.startsOn)}, ends ${prettyDay(p.endsOn)}`}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={ending} onClick={() => end(p.id)}>
                  {started ? 'End it now' : 'Cancel it'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {endState.error && <Notice>{endState.error}</Notice>}
      {endState.success && <Notice tone="success">{endState.success}</Notice>}

      <form action={formAction} className="space-y-4 rounded-card border border-line p-4">
        {/* READS AS A SENTENCE rather than a grid of labelled boxes. Six fields in a form
            layout is a thing to fill in; one line of English is a thing to check. */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
          <span>Take</span>
          <input
            name="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="decimal"
            aria-label="How much off"
            className="w-20 min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-right text-sm tabular-nums text-ink"
          />
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'percent' | 'amount')}
            aria-label="A percentage or an amount"
            className="min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="percent">% off</option>
            <option value="amount">$ off</option>
          </select>
          <span>off</span>
          <select
            name="tierKey"
            value={tierKey}
            onChange={(e) => setTierKey(e.target.value)}
            aria-label="Which service"
            className="min-h-11 max-w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="">every service</option>
            {entries.map((e) => (
              <option key={e.tierKey} value={e.tierKey}>
                {e.label}
              </option>
            ))}
          </select>
          <span>from</span>
          <input
            type="date"
            name="startsOn"
            value={startsOn}
            min={today}
            onChange={(e) => setStartsOn(e.target.value)}
            aria-label="First day"
            className="min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
          <span>to</span>
          <input
            type="date"
            name="endsOn"
            value={endsOn}
            min={startsOn || today}
            onChange={(e) => setEndsOn(e.target.value)}
            aria-label="Last day, included"
            className="min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>

        <label className="block text-xs">
          <span className="block text-ink-faint">
            What is it called? Providers see this on their receipt.
          </span>
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. October promotion"
            className="mt-1 w-full min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>

        {invalid && <Notice>{invalid}</Notice>}

        {effect.length > 0 && (
          // The same gold panel the schedule form uses to read a change back before publishing.
          <section className="rounded-card border border-gold/40 bg-gold/5 p-5">
            <h3 className="text-sm font-medium">
              What this does
              {span !== null && (
                <span className="text-ink-faint">
                  {' '}
                  · {span} day{span === 1 ? '' : 's'}, {prettyDay(startsOn)} to {prettyDay(endsOn)}
                </span>
              )}
            </h3>
            <ul className="mt-3 space-y-1">
              {effect.slice(0, 8).map((e) => (
                <li key={e.label} className="text-xs tabular-nums text-ink-secondary">
                  <span className="text-ink">{e.label}</span>
                  <span className="text-ink-faint"> · </span>
                  {usd(e.from)} → <strong>{usd(e.to)}</strong>
                  {/* What the provider is actually charged, because the schedule is what
                      Melanite keeps and the card takes processing on top. Keoni reads this
                      figure against a statement; the other one she never sees. */}
                  <span className="text-ink-faint"> · {usd(e.charged)} charged</span>
                </li>
              ))}
            </ul>
            {effect.length > 8 && (
              <p className="mt-2 text-xs text-ink-faint">
                …and {effect.length - 8} more, every service on the schedule.
              </p>
            )}
            <p className="mt-3 text-xs text-ink-secondary">
              Nobody has to accept anything. Sessions already booked inside those dates get the
              promotional price too — it is worked out on the day of the session, not the day it
              was booked.
            </p>
          </section>
        )}

        {state.error && <Notice>{state.error}</Notice>}
        {state.success && <Notice tone="success">{state.success}</Notice>}

        <StartButton disabled={!typed || invalid !== null || effect.length === 0} />
      </form>
    </section>
  )
}
