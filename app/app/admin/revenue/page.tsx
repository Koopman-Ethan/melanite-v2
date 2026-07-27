import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { getAdminRevenue } from '@/lib/db/queries/revenue'

export const metadata: Metadata = { title: 'Revenue · Melanite Admin' }

// Money figures must never be served stale.
export const dynamic = 'force-dynamic'

const SOURCE_LABELS: Record<string, string> = {
  booking: 'Laser bookings',
  package: 'Packages',
  room_rental: 'Room rental',
  membership: 'Medical director',
  training: 'Training',
}

const SOURCE_COLORS: Record<string, string> = {
  booking: 'bg-gold',
  package: 'bg-info',
  room_rental: 'bg-warning',
  membership: 'bg-success',
  training: 'bg-gold-dim',
}

const usd = (value: string | number) =>
  Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line p-5">
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  )
}

const METHOD_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  cherry: 'Cherry financing',
  groupon: 'Groupon',
  cash: 'Cash',
  check: 'Check',
  other: 'Other',
}

export default async function AdminRevenuePage() {
  // Authorization happens here, not in proxy.ts — the DAL is the boundary.
  await requireAdmin()
  const { totals, bySource, byMethod, byProvider, byService, series, recent } =
    await getAdminRevenue()

  const lifetime = Number(totals.lifetimeRevenue)
  const peakMonth = Math.max(...series.map((s) => Number(s.revenue)), 1)

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Revenue</h1>
        <p className="mt-1 text-sm text-ink-muted">Every revenue stream, from one ledger.</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Platform revenue" value={usd(totals.lifetimeRevenue)} hint="lifetime, net of refunds" />
        <Stat label="This month" value={usd(totals.monthRevenue)} hint="America/Denver" />
        <Stat label="Gross collected" value={usd(totals.lifetimeGross)} hint="before the provider split" />
        <Stat label="Paid to providers" value={usd(totals.lifetimePayouts)} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By source</h2>
        <div className="rounded-card border border-line divide-y divide-line">
          {bySource.map((row) => {
            const revenue = Number(row.revenue)
            const share = lifetime > 0 ? (revenue / lifetime) * 100 : 0
            return (
              <div key={row.source} className="flex items-center gap-4 p-4">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${SOURCE_COLORS[row.source] ?? 'bg-neutral-400'}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="truncate text-sm font-medium">
                      {SOURCE_LABELS[row.source] ?? row.source}
                    </span>
                    <span className="tabular-nums text-sm font-semibold">{usd(row.revenue)}</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-line">
                    <div
                      className={`h-full rounded-full ${SOURCE_COLORS[row.source] ?? 'bg-neutral-400'}`}
                      style={{ width: `${Math.max(share, 0)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex gap-4 text-xs text-ink-faint tabular-nums">
                    <span>{share.toFixed(1)}% of revenue</span>
                    <span>{usd(row.gross)} gross</span>
                    <span>
                      {row.entries} {row.entries === 1 ? 'entry' : 'entries'}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          By payment method
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {byMethod.map((row) => (
            <div
              key={row.method}
              className="rounded-card border border-line p-4"
            >
              <div className="text-xs text-ink-muted">{METHOD_LABELS[row.method] ?? row.method}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{usd(row.revenue)}</div>
              <div className="mt-0.5 text-xs text-ink-faint tabular-nums">
                {row.entries} {row.entries === 1 ? 'entry' : 'entries'}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-faint">
          Only Stripe figures reconcile automatically. Cherry, Groupon, cash and check are
          recorded by hand — they are real revenue that never produced a Stripe charge, so they
          are reported here but cannot be verified against Stripe.
        </p>
      </section>

      {series.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By month</h2>
          <div className="rounded-card border border-line p-5">
            <div className="flex h-40 items-end gap-2">
              {series.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-gold"
                      style={{ height: `${(Number(m.revenue) / peakMonth) * 100}%` }}
                      title={`${monthLabel(m.month)} — ${usd(m.revenue)}`}
                    />
                  </div>
                  <span className="text-[10px] text-ink-faint">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By provider</h2>
          <div
              tabIndex={0}
              role="region"
              aria-label="Scrollable table"
              className="overflow-x-auto rounded-card border border-line"
            >
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-muted">
                <tr className="border-b border-line">
                  <th className="p-3 text-left font-medium">Provider</th>
                  <th className="p-3 text-right font-medium">Revenue</th>
                  <th className="p-3 text-right font-medium">Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byProvider.map((row) => (
                  <tr key={row.providerId ?? 'unattributed'}>
                    <td className="p-3">{row.providerName}</td>
                    <td className="p-3 text-right tabular-nums">{usd(row.revenue)}</td>
                    <td className="p-3 text-right tabular-nums text-ink-muted">{usd(row.payouts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

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
                  <th className="p-3 text-right font-medium">Revenue</th>
                  <th className="p-3 text-right font-medium">Sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byService.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-3 text-xs text-ink-faint">
                      No service-attributed revenue yet.
                    </td>
                  </tr>
                )}
                {byService.map((row) => (
                  <tr key={row.serviceId}>
                    <td className="p-3">{row.serviceName}</td>
                    <td className="p-3 text-right tabular-nums">{usd(row.revenue)}</td>
                    <td className="p-3 text-right tabular-nums text-ink-muted">{row.entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint">
            Only bookings and packages attribute to a service. Memberships, room rental and
            training have none by nature, so they are excluded rather than bucketed as unknown.
          </p>
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Recent entries</h2>
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
                <th className="p-3 text-left font-medium">Source</th>
                <th className="p-3 text-left font-medium">Provider</th>
                <th className="p-3 text-right font-medium">Gross</th>
                <th className="p-3 text-right font-medium">Platform</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {/* No row-level opacity on refunds. Dimming a row dims every colour inside it —
                  the refund badge measured 2.71:1 that way — and the badge already says
                  "refund", so the opacity was decoration doing damage. */}
              {recent.map((entry) => (
                <tr key={entry.id}>
                  <td className="p-3 whitespace-nowrap tabular-nums">
                    {entry.createdAt.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'America/Denver',
                    })}
                  </td>
                  <td className="p-3">
                    <span className="whitespace-nowrap">
                      {SOURCE_LABELS[entry.source] ?? entry.source}
                    </span>
                    {entry.entryType === 'refund' && (
                      <span className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-danger">
                        refund
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-ink-muted">{entry.providerName ?? '—'}</td>
                  <td className="p-3 text-right tabular-nums">{usd(entry.gross)}</td>
                  <td className="p-3 text-right tabular-nums font-medium">{usd(entry.melaniteCut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
