import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { getEarnings } from '@/lib/db/queries/earnings'

export const metadata: Metadata = { title: 'Earnings · Melanite' }
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
  booking: 'Appointment',
  package: 'Package sale',
  room_rental: 'Room rental',
  membership: 'Membership',
  training: 'Training',
}

export default async function EarningsPage() {
  const user = await requireProvider()
  const { totals, unearned, redeemed, series, byService, recent } = await getEarnings(user.id)

  const peak = Math.max(
    ...series.map((m) => Number(m.earned) + Number(m.prepaid)),
    1,
  )

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Earnings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Your share of every appointment and package, after Melanite&rsquo;s cut.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Earned</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.earnedLifetime)}</div>
          <div className="mt-1 text-xs text-ink-faint">
            {usd(totals.earnedMonth)} this month · work delivered
          </div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Awaiting payout</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.pendingPayout)}</div>
          <div className="mt-1 text-xs text-ink-faint">not yet sent to your bank</div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Package sales</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.prepaidLifetime)}</div>
          <div className="mt-1 text-xs text-ink-faint">
            {usd(totals.prepaidMonth)} this month · paid up front
          </div>
        </div>

        <div className="rounded-card border border-line bg-surface p-5">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Tips</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">{usd(totals.tipsLifetime)}</div>
          <div className="mt-1 text-xs text-ink-faint">already inside the figures above</div>
        </div>
      </section>

      {/* The distinction v1's endpoint spells out and this page exists to keep visible: a
          package pays out at PURCHASE, so part of that money is for work not yet done.
          Shown only when there is something outstanding — otherwise it is noise. */}
      {Number(unearned.value) > 0 && (
        <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-warning">Sessions you still owe</h2>
            <span className="text-2xl font-semibold tabular-nums">{usd(unearned.value)}</span>
          </div>
          <p className="mt-2 text-sm text-ink-secondary">
            {unearned.sessionsRemaining}{' '}
            {unearned.sessionsRemaining === 1 ? 'session' : 'sessions'} remaining across{' '}
            {unearned.activePackages}{' '}
            {unearned.activePackages === 1 ? 'active package' : 'active packages'}.
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Package money reaches you when the client pays, not when the treatment happens — so
            some of your package total above is for work still to come. {redeemed.lifetime}{' '}
            {redeemed.lifetime === 1 ? 'session has' : 'sessions have'} been delivered so far
            {redeemed.month > 0 && `, ${redeemed.month} this month`}.
          </p>
        </section>
      )}

      {series.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By month</h2>
          <div className="rounded-card border border-line bg-surface p-5">
            <div className="flex h-40 items-end gap-2">
              {series.map((m) => {
                const earned = Number(m.earned)
                const prepaid = Number(m.prepaid)
                return (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                    <div className="flex w-full flex-1 flex-col justify-end gap-px">
                      {prepaid > 0 && (
                        <div
                          className="w-full rounded-t bg-gold-dim"
                          style={{ height: `${(prepaid / peak) * 100}%` }}
                          title={`${monthLabel(m.month)} — ${usd(prepaid)} package sales`}
                        />
                      )}
                      <div
                        className={cn('w-full bg-gold', prepaid > 0 ? '' : 'rounded-t')}
                        style={{ height: `${(earned / peak) * 100}%` }}
                        title={`${monthLabel(m.month)} — ${usd(earned)} earned`}
                      />
                    </div>
                    <span className="text-[10px] text-ink-faint">{monthLabel(m.month)}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-4 flex gap-4 text-xs text-ink-faint">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-gold" /> Earned
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-gold-dim" /> Package sales
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By service</h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">Service</th>
                <th className="p-3 text-right font-medium">Appointments</th>
                <th className="p-3 text-right font-medium">Collected</th>
                <th className="p-3 text-right font-medium">Your share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {byService.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-4 text-xs text-ink-faint">
                    No completed appointment revenue yet.
                  </td>
                </tr>
              )}
              {byService.map((s) => (
                <tr key={s.serviceName}>
                  <td className="p-3">{s.serviceName}</td>
                  <td className="p-3 text-right tabular-nums text-ink-muted">{s.count}</td>
                  <td className="p-3 text-right tabular-nums text-ink-muted">{usd(s.gross)}</td>
                  <td className="p-3 text-right tabular-nums font-medium">{usd(s.payout)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-faint">
          Appointments only. A package sale isn&rsquo;t tied to one service until its sessions
          are booked, so splitting it across services would be an estimate sitting next to
          measured numbers.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Recent</h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-line">
                <th className="p-3 text-left font-medium">Date</th>
                <th className="p-3 text-left font-medium">Source</th>
                <th className="p-3 text-right font-medium">Collected</th>
                <th className="p-3 text-right font-medium">Your share</th>
                <th className="p-3 text-left font-medium">Payout</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-4 text-xs text-ink-faint">
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
                    {r.clientName && (
                      <span className="text-ink-faint"> · {r.clientName}</span>
                    )}
                    {r.entryType === 'refund' && (
                      <span className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-danger">
                        refund
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-right tabular-nums text-ink-muted">{usd(r.gross)}</td>
                  <td className="p-3 text-right tabular-nums font-medium">{usd(r.payout)}</td>
                  <td className="p-3">
                    <span
                      className={cn(
                        'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                        r.payoutStatus === 'paid'
                          ? 'border-success/40 bg-success/10 text-success'
                          : r.payoutStatus === 'failed'
                            ? 'border-danger/40 bg-danger/10 text-danger'
                            : 'border-info/40 bg-info/10 text-info',
                      )}
                    >
                      {r.payoutStatus}
                    </span>
                    {r.payoutDate && (
                      <span className="ml-2 text-xs text-ink-faint tabular-nums">
                        {r.payoutDate}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
