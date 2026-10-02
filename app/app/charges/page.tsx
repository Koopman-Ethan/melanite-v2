import type { Metadata } from 'next'
import Link from 'next/link'

import { requireProvider } from '@/lib/auth/dal'
import { GROWTH_HUB } from '@/lib/product-names'
import { cn } from '@/lib/cn'
import { getCharges } from '@/lib/db/queries/charges'
import { packBalancesFor } from '@/lib/rental/packs'

export const metadata: Metadata = { title: 'Charges · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

const SOURCE_LABELS: Record<string, string> = {
  rental_fee: 'Laser rental',
  room_rental: 'Room rental',
  membership: 'Medical direction',
  epicutis: GROWTH_HUB,
}

/** What a provider pays Melanite.
 *
 *  Replaces the earnings page, which under the rental model would have nothing to show: Melanite
 *  no longer collects anything on a provider's behalf, so there is no share to report and no
 *  payout to wait for. The provider's income is their own business now, recorded wherever they
 *  record it.
 *
 *  Deliberately NOT framed as a balance. Nothing is ever outstanding — a rental fee is taken when
 *  the slot is reserved, and a booking whose card declines does not exist — so this is a
 *  statement rather than a bill. The one forward-looking figure is the pack balance, which is
 *  laser time already bought.
 */
export default async function ChargesPage() {
  const user = await requireProvider()
  const [{ totals, series, byService, recent }, packs] = await Promise.all([
    getCharges(user.id),
    packBalancesFor(user.id),
  ])

  const peak = Math.max(...series.map((m) => Number(m.rental) + Number(m.recurring)), 1)
  const perSession =
    totals.sessionsMonth > 0 ? Number(totals.rentalMonth) / totals.sessionsMonth : null

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Charges</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What you pay Melanite for the equipment and the room. What you charge your own clients
          doesn&rsquo;t come through here.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">This month</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.allMonth)}</div>
          <div className="mt-1 text-xs text-ink-faint">{usd(totals.allLifetime)} all time</div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Laser rental</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.rentalMonth)}</div>
          <div className="mt-1 text-xs text-ink-faint">
            {totals.sessionsMonth} {totals.sessionsMonth === 1 ? 'session' : 'sessions'} this month
          </div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Per session</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">
            {perSession === null ? '—' : usd(perSession)}
          </div>
          <div className="mt-1 text-xs text-ink-faint">
            {/* The number a pack is meant to move, so it is shown next to the pack balance
                rather than left for the provider to work out with a calculator. */}
            average this month
          </div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Monthly costs</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">
            {usd(totals.recurringMonth)}
          </div>
          <div className="mt-1 text-xs text-ink-faint">room, direction, {GROWTH_HUB}</div>
        </div>
      </section>

      {packs.length > 0 && (
        <section className="rounded-card border border-success/30 bg-success/10 p-5">
          <h2 className="text-sm font-medium">Laser time you&rsquo;ve already bought</h2>
          <ul className="mt-3 space-y-2">
            {packs.map((p) => (
              <li
                key={p.tierKey}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span>{p.label}</span>
                <span className="tabular-nums">
                  <strong>{p.sessionsRemaining}</strong>
                  <span className="text-ink-muted"> of {p.sessionsTotal} left</span>
                  {p.singleCents !== null && (
                    <span className="text-ink-faint">
                      {' '}
                      · worth {usd((p.sessionsRemaining * p.singleCents) / 100)} at the
                      single-session rate
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-faint">
            These are spent automatically, oldest pack first, when you book a service in that
            bracket. Nothing is charged to your card while a session is left.
          </p>
        </section>
      )}

      {series.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By month</h2>
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="flex h-40 gap-2">
              {series.map((m) => {
                const rental = Number(m.rental)
                const recurring = Number(m.recurring)
                return (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                    <div className="flex w-full flex-1 flex-col justify-end gap-px">
                      {recurring > 0 && (
                        <div
                          className="w-full rounded-t bg-gold-dim"
                          style={{ height: `${(recurring / peak) * 100}%` }}
                          title={`${monthLabel(m.month)} — ${usd(recurring)} monthly costs`}
                        />
                      )}
                      <div
                        className={cn('w-full bg-gold', recurring > 0 ? '' : 'rounded-t')}
                        style={{ height: `${(rental / peak) * 100}%` }}
                        title={`${monthLabel(m.month)} — ${usd(rental)} laser rental`}
                      />
                    </div>
                    <span className="text-[10px] text-ink-faint">{monthLabel(m.month)}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-4 flex gap-4 text-xs text-ink-faint">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-gold" /> Laser rental
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-gold-dim" /> Monthly costs
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By service</h2>
        <div
          tabIndex={0}
          role="region"
          aria-label="Scrollable table"
          className="overflow-x-auto rounded-card border border-line"
        >
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">Service</th>
                <th className="p-3 text-right font-medium">Sessions</th>
                <th className="p-3 text-right font-medium">Rent paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {byService.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-xs text-ink-faint">
                    No laser rental yet.
                  </td>
                </tr>
              )}
              {byService.map((s) => (
                <tr key={s.serviceName}>
                  <td className="p-3">{s.serviceName}</td>
                  <td className="p-3 text-right tabular-nums text-ink-muted">{s.sessions}</td>
                  <td className="p-3 text-right tabular-nums font-medium">{usd(s.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint">
          Sessions covered by a pack aren&rsquo;t listed here — a pack is bought against a
          bracket rather than one service, so putting its cost against a single service would be
          a figure nobody charged you.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Recent</h2>
        <div
          tabIndex={0}
          role="region"
          aria-label="Scrollable table"
          className="overflow-x-auto rounded-card border border-line"
        >
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">Date</th>
                <th className="p-3 text-left font-medium">What for</th>
                <th className="p-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {recent.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-xs text-ink-faint">
                    Nothing yet.
                  </td>
                </tr>
              )}
              {recent.map((r) => (
                <tr key={r.id} className={r.entryType === 'refund' ? 'opacity-70' : undefined}>
                  <td className="p-3 whitespace-nowrap tabular-nums">
                    {r.createdAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'America/Denver',
                    })}
                  </td>
                  <td className="p-3">
                    <span className="whitespace-nowrap">
                      {SOURCE_LABELS[r.source] ?? r.source}
                    </span>
                    {r.serviceName && <span className="text-ink-faint"> · {r.serviceName}</span>}
                    {r.startTime && (
                      <span className="text-ink-faint">
                        {' '}
                        ·{' '}
                        {r.startTime.toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          timeZone: 'America/Denver',
                        })}
                      </span>
                    )}
                    {r.entryType === 'refund' && (
                      <span className="ml-2 rounded bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success">
                        refunded
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums font-medium">{usd(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint">
          Every line here is a charge to your card on file. If a client doesn&rsquo;t turn up,
          tell Melanite and the rental fee for that session comes back —{' '}
          <Link href="/app/appointments" className="underline underline-offset-4">
            mark it as a no-show
          </Link>
          .
        </p>
      </section>
    </main>
  )
}
