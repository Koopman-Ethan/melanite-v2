'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import {
  describePromotion,
  discountedCents,
  prettyDay,
  promotionFor,
  type Promotion,
} from '@/lib/promotions'

import { publishPricing, type PricingState } from './actions'

export interface EntryView {
  tierKey: string
  label: string
  singleCents: number
  suggestedLowCents: number
  suggestedHighCents: number
  fromSeed: boolean
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** Dollars, for an input. No trailing ".00" — nobody types that. */
const dollars = (cents: number) => String(cents / 100)

function PublishButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? 'Publishing…' : 'Publish these prices'}
    </Button>
  )
}

/**
 * Editing the fee schedule.
 *
 * Two things make this different from an ordinary settings form, and both are visible in the
 * layout rather than left to a tooltip:
 *
 *   The diff. Money typed into a box is money somebody will be charged, so nothing is published
 *   until the changes have been read back as "was → now". A mistyped 1200 instead of 120 is
 *   obvious in a diff and invisible in a field.
 *
 *   The consequence. Publishing asks every provider to accept the new prices before they can
 *   book again, so the count of who that affects is on the button, not in a help page.
 */
export function PricingForm({
  version,
  publishedAt,
  note,
  entries,
  awaitingAcceptance,
  promotions,
  today,
}: {
  version: number | null
  publishedAt: string | null
  note: string | null
  entries: EntryView[]
  awaitingAcceptance: number
  /** Running or queued, so a tier can say what is actually being charged for it right now.
   *  Without this the table is the published price and the statement is something else, and
   *  the difference is invisible on the page that exists to explain prices. */
  promotions: Promotion[]
  /** Denver's today, from the server. */
  today: string
}) {
  const [state, formAction] = useActionState<PricingState, FormData>(publishPricing, {})

  // Kept as the raw strings the person typed. Parsing on every keystroke would fight anybody
  // halfway through typing "1" of "150".
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      entries.map((e) => [
        e.tierKey,
        {
          fee: dollars(e.singleCents),
          low: dollars(e.suggestedLowCents),
          high: dollars(e.suggestedHighCents),
        },
      ]),
    ),
  )

  const set = (key: string, field: 'fee' | 'low' | 'high', value: string) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }))

  const changes = useMemo(() => {
    const out: { label: string; what: string; from: number; to: number }[] = []
    for (const e of entries) {
      const d = draft[e.tierKey]
      const cents = (v: string) => Math.round(Number(v) * 100)
      if (Number.isFinite(Number(d.fee)) && cents(d.fee) !== e.singleCents) {
        out.push({ label: e.label, what: 'rental fee', from: e.singleCents, to: cents(d.fee) })
      }
      if (Number.isFinite(Number(d.low)) && cents(d.low) !== e.suggestedLowCents) {
        out.push({
          label: e.label,
          what: 'suggested from',
          from: e.suggestedLowCents,
          to: cents(d.low),
        })
      }
      if (Number.isFinite(Number(d.high)) && cents(d.high) !== e.suggestedHighCents) {
        out.push({
          label: e.label,
          what: 'suggested to',
          from: e.suggestedHighCents,
          to: cents(d.high),
        })
      }
    }
    return out
  }, [draft, entries])

  // A fee at or above what the treatment sells for is renting at a loss. The database refuses
  // it; saying so here means not finding out after pressing Publish.
  const invalid = useMemo(
    () =>
      entries
        .filter((e) => {
          const d = draft[e.tierKey]
          const fee = Math.round(Number(d.fee) * 100)
          const low = Math.round(Number(d.low) * 100)
          return Number.isFinite(fee) && Number.isFinite(low) && fee >= low
        })
        .map((e) => e.label),
    [draft, entries],
  )

  /** The promotion reducing each tier TODAY, if any. Queued ones are listed in the section
   *  below instead — on this table they would claim a price that is not being charged yet. */
  const live = useMemo(() => {
    const out = new Map<string, Promotion>()
    for (const e of entries) {
      const promo = promotionFor(e.tierKey, today, promotions)
      if (promo) out.set(e.tierKey, promo)
    }
    return out
  }, [entries, promotions, today])

  const seeded = entries.filter((e) => e.fromSeed)

  return (
    <form action={formAction} className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-card border border-line p-4">
        <div className="text-sm">
          {version === null ? (
            <span className="text-warning">Nothing published yet — these are the code defaults.</span>
          ) : (
            <>
              <strong>Schedule v{version}</strong>
              <span className="text-ink-muted"> · published {publishedAt}</span>
            </>
          )}
        </div>
        {awaitingAcceptance > 0 && (
          <span className="text-xs text-warning">
            {awaitingAcceptance} provider{awaitingAcceptance === 1 ? '' : 's'} yet to accept the
            current prices
          </span>
        )}
      </div>

      {note && <p className="text-xs text-ink-faint">Last change: {note}</p>}

      {seeded.length > 0 && (
        <Notice tone="warning">
          {seeded.length} tier{seeded.length === 1 ? ' is' : 's are'} priced from the code
          defaults because they were added after the last publish — {seeded.map((e) => e.label).join(', ')}.
          They are bookable at the price shown. Publishing writes every tier and clears this.
        </Notice>
      )}

      <div
        tabIndex={0}
        role="region"
        aria-label="Scrollable table"
        className="overflow-x-auto rounded-card border border-line"
      >
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-line">
              <th className="p-3 text-left font-medium">Tier</th>
              <th className="p-3 text-right font-medium">Rental fee</th>
              <th className="p-3 text-right font-medium">Typically sells for</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => {
              const d = draft[e.tierKey]
              const bad = invalid.includes(e.label)
              return (
                <tr key={e.tierKey}>
                  <td className="p-3">
                    <input type="hidden" name="tierKey" value={e.tierKey} />
                    {e.label}
                  </td>
                  <td className="p-3 text-right">
                    <label className="sr-only" htmlFor={`fee-${e.tierKey}`}>
                      {e.label} rental fee in dollars
                    </label>
                    <span className="text-ink-faint">$</span>
                    <input
                      id={`fee-${e.tierKey}`}
                      name={`fee:${e.tierKey}`}
                      value={d.fee}
                      onChange={(ev) => set(e.tierKey, 'fee', ev.target.value)}
                      inputMode="decimal"
                      className={cn(
                        'ml-1 w-20 rounded-field border bg-surface px-2 py-1 text-right text-sm tabular-nums',
                        bad ? 'border-danger text-danger' : 'border-line text-ink',
                      )}
                    />
                    {/* WHAT IS ACTUALLY BEING CHARGED, under the price that would be without a
                        promotion. Not a strikethrough on the input, which is editable and
                        would read as the value being wrong — this is a second fact about the
                        tier, not a correction to the field. */}
                    {live.get(e.tierKey) && (
                      <p className="mt-1 text-[11px] text-gold tabular-nums">
                        {describePromotion(live.get(e.tierKey)!)} → {usd(
                          discountedCents(e.singleCents, live.get(e.tierKey)!),
                        )}{' '}
                        until {prettyDay(live.get(e.tierKey)!.endsOn)}
                      </p>
                    )}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <label className="sr-only" htmlFor={`low-${e.tierKey}`}>
                      {e.label} suggested price from, in dollars
                    </label>
                    <span className="text-ink-faint">$</span>
                    <input
                      id={`low-${e.tierKey}`}
                      name={`low:${e.tierKey}`}
                      value={d.low}
                      onChange={(ev) => set(e.tierKey, 'low', ev.target.value)}
                      inputMode="decimal"
                      className="ml-1 w-20 rounded-field border border-line bg-surface px-2 py-1 text-right text-sm tabular-nums text-ink"
                    />
                    <span className="mx-1 text-ink-faint">–$</span>
                    <label className="sr-only" htmlFor={`high-${e.tierKey}`}>
                      {e.label} suggested price to, in dollars
                    </label>
                    <input
                      id={`high-${e.tierKey}`}
                      name={`high:${e.tierKey}`}
                      value={d.high}
                      onChange={(ev) => set(e.tierKey, 'high', ev.target.value)}
                      inputMode="decimal"
                      className="w-20 rounded-field border border-line bg-surface px-2 py-1 text-right text-sm tabular-nums text-ink"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-faint">
        &ldquo;Typically sells for&rdquo; is what the market research found local clinics
        charging. It is shown to providers as a reference and is never charged to anyone — but
        the rental fee has to stay below it, because the whole arrangement is that the fee is
        about half of market and the provider keeps the rest.
      </p>

      {invalid.length > 0 && (
        <Notice>
          These would rent the laser at or above what the treatment sells for:{' '}
          {invalid.join(', ')}. Lower the fee, or raise the suggested price if the market has
          moved.
        </Notice>
      )}

      {changes.length > 0 && (
        <section className="rounded-card border border-gold/40 bg-gold/5 p-5">
          <h2 className="text-sm font-medium">
            {changes.length} change{changes.length === 1 ? '' : 's'} to publish
          </h2>
          <ul className="mt-3 space-y-1">
            {changes.map((c, i) => (
              <li key={i} className="text-xs tabular-nums text-ink-secondary">
                <span className="text-ink">{c.label}</span>
                <span className="text-ink-faint"> · {c.what} · </span>
                {usd(c.from)} → <strong>{usd(c.to)}</strong>
                <span className="text-ink-faint">
                  {' '}
                  ({c.to > c.from ? '+' : ''}
                  {Math.round(((c.to - c.from) / c.from) * 100)}%)
                </span>
              </li>
            ))}
          </ul>

          <label className="mt-4 block text-xs">
            <span className="block text-ink-faint">Why are these changing?</span>
            <input
              name="note"
              required
              placeholder="e.g. market review, October 2026"
              className="mt-1 w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>

          <p className="mt-3 text-xs text-ink-secondary">
            Publishing asks every provider to accept the new prices before their next booking.
            It takes them one tap on the booking page, but until they do, they cannot book.
          </p>
        </section>
      )}

      {state.error && <Notice>{state.error}</Notice>}
      {state.success && <Notice tone="success">{state.success}</Notice>}

      <div className="flex items-center gap-3">
        <PublishButton disabled={changes.length === 0 || invalid.length > 0} />
        {/* Suppressed right after a publish. "Nothing has changed yet" is true — the draft now
            matches what was just published — but sitting under "Published schedule v2" it reads
            as a contradiction of the thing that just happened. */}
        {changes.length === 0 && !state.success && (
          <span className="text-xs text-ink-faint">Nothing has changed yet.</span>
        )}
      </div>
    </form>
  )
}
