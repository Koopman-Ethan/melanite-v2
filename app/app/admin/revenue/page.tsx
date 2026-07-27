import type { Metadata } from 'next'

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
  booking: 'bg-[#B8965A]',
  package: 'bg-[#5a8ec7]',
  room_rental: 'bg-[#d4a04e]',
  membership: 'bg-[#7fa87f]',
  training: 'bg-[#a87f9e]',
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
    <div className="rounded-lg border border-black/10 dark:border-white/15 p-5">
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs opacity-60">{hint}</div>}
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
  const { totals, bySource, byMethod, byProvider, byService, series, recent } =
    await getAdminRevenue()

  const lifetime = Number(totals.lifetimeRevenue)
  const peakMonth = Math.max(...series.map((s) => Number(s.revenue)), 1)

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Revenue</h1>
        <p className="mt-1 text-sm opacity-70">
          Every revenue stream, from one ledger.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Platform revenue" value={usd(totals.lifetimeRevenue)} hint="lifetime, net of refunds" />
        <Stat label="This month" value={usd(totals.monthRevenue)} hint="America/Denver" />
        <Stat label="Gross collected" value={usd(totals.lifetimeGross)} hint="before the provider split" />
        <Stat label="Paid to providers" value={usd(totals.lifetimePayouts)} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">By source</h2>
        <div className="rounded-lg border border-black/10 dark:border-white/15 divide-y divide-black/10 dark:divide-white/10">
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
                  <div className="mt-2 h-1.5 rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className={`h-full rounded-full ${SOURCE_COLORS[row.source] ?? 'bg-neutral-400'}`}
                      style={{ width: `${Math.max(share, 0)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex gap-4 text-xs opacity-60 tabular-nums">
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
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          By payment method
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {byMethod.map((row) => (
            <div
              key={row.method}
              className="rounded-lg border border-black/10 dark:border-white/15 p-4"
            >
              <div className="text-xs opacity-60">{METHOD_LABELS[row.method] ?? row.method}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{usd(row.revenue)}</div>
              <div className="mt-0.5 text-xs opacity-60 tabular-nums">
                {row.entries} {row.entries === 1 ? 'entry' : 'entries'}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs opacity-60">
          Only Stripe figures reconcile automatically. Cherry, Groupon, cash and check are
          recorded by hand — they are real revenue that never produced a Stripe charge, so they
          are reported here but cannot be verified against Stripe.
        </p>
      </section>

      {series.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">By month</h2>
          <div className="rounded-lg border border-black/10 dark:border-white/15 p-5">
            <div className="flex h-40 items-end gap-2">
              {series.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t bg-[#B8965A]"
                      style={{ height: `${(Number(m.revenue) / peakMonth) * 100}%` }}
                      title={`${monthLabel(m.month)} — ${usd(m.revenue)}`}
                    />
                  </div>
                  <span className="text-[10px] opacity-60">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">By provider</h2>
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide opacity-60">
                <tr className="border-b border-black/10 dark:border-white/15">
                  <th className="p-3 text-left font-medium">Provider</th>
                  <th className="p-3 text-right font-medium">Revenue</th>
                  <th className="p-3 text-right font-medium">Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/10">
                {byProvider.map((row) => (
                  <tr key={row.providerId ?? 'unattributed'}>
                    <td className="p-3">{row.providerName}</td>
                    <td className="p-3 text-right tabular-nums">{usd(row.revenue)}</td>
                    <td className="p-3 text-right tabular-nums opacity-70">{usd(row.payouts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">By service</h2>
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide opacity-60">
                <tr className="border-b border-black/10 dark:border-white/15">
                  <th className="p-3 text-left font-medium">Service</th>
                  <th className="p-3 text-right font-medium">Revenue</th>
                  <th className="p-3 text-right font-medium">Sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/10">
                {byService.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-3 text-xs opacity-60">
                      No service-attributed revenue yet.
                    </td>
                  </tr>
                )}
                {byService.map((row) => (
                  <tr key={row.serviceId}>
                    <td className="p-3">{row.serviceName}</td>
                    <td className="p-3 text-right tabular-nums">{usd(row.revenue)}</td>
                    <td className="p-3 text-right tabular-nums opacity-70">{row.entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs opacity-60">
            Only bookings and packages attribute to a service. Memberships, room rental and
            training have none by nature, so they are excluded rather than bucketed as unknown.
          </p>
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">Recent entries</h2>
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide opacity-60">
              <tr className="border-b border-black/10 dark:border-white/15">
                <th className="p-3 text-left font-medium">Date</th>
                <th className="p-3 text-left font-medium">Source</th>
                <th className="p-3 text-left font-medium">Provider</th>
                <th className="p-3 text-right font-medium">Gross</th>
                <th className="p-3 text-right font-medium">Platform</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/10">
              {recent.map((entry) => (
                <tr key={entry.id} className={entry.entryType === 'refund' ? 'opacity-70' : undefined}>
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
                      <span className="ml-2 rounded bg-[#c75c5c]/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#c75c5c]">
                        refund
                      </span>
                    )}
                  </td>
                  <td className="p-3 opacity-70">{entry.providerName ?? '—'}</td>
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
