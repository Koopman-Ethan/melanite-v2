import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import { getProviderLicenses } from '@/lib/db/queries/admin-tools'
import { getRevenueTotals } from '@/lib/db/queries/revenue'
import { licenseStatus, licenseUrgency } from '@/lib/license'

export const metadata: Metadata = { title: 'Admin · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function AdminHome() {
  const user = await requireAdmin()
  const [totals, licenses] = await Promise.all([getRevenueTotals(), getProviderLicenses()])

  // Only what needs acting on. A list of every provider whose license is fine is a list nobody
  // reads, and a panel that is always there stops being noticed.
  const needsAttention = licenses
    .map((provider) => ({ ...provider, status: licenseStatus(provider.licenseExpiry) }))
    .filter((provider) => provider.status.state !== 'ok')
    .sort((a, b) => licenseUrgency(a.status) - licenseUrgency(b.status))

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Welcome back, {user.firstName}</h1>
        <p className="mt-1 text-sm text-ink-muted">Platform overview</p>
      </header>

      {needsAttention.length > 0 && (
        <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
          <h2 className="text-sm font-medium text-warning">
            {needsAttention.length === 1
              ? '1 license needs attention'
              : `${needsAttention.length} licenses need attention`}
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            A lapsed license blocks booking outright, and renewals go through Melanite. This is
            the only place that shows it coming.
          </p>
          <ul className="mt-4 space-y-2">
            {needsAttention.map((provider) => (
              <li
                key={provider.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-2 text-sm"
              >
                <span>
                  {provider.name}
                  <span className="ml-2 text-xs text-ink-faint">{provider.email}</span>
                </span>
                {/* Said in words, not by colour alone. */}
                <span className="text-xs text-ink-secondary">
                  {provider.status.state === 'missing'
                    ? 'no expiry date on file'
                    : provider.status.state === 'expired'
                      ? `expired ${Math.abs(provider.status.daysLeft!)} day${Math.abs(provider.status.daysLeft!) === 1 ? '' : 's'} ago — booking blocked`
                      : `expires in ${provider.status.daysLeft} day${provider.status.daysLeft === 1 ? '' : 's'} (${provider.licenseExpiry})`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link
        href="/app/admin/revenue"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Platform revenue</div>
        <div className="mt-2 text-4xl font-semibold tabular-nums">{usd(totals.lifetimeRevenue)}</div>
        <div className="mt-1 text-sm text-ink-faint">
          {usd(totals.monthRevenue)} this month · across every revenue stream
        </div>
        <div className="mt-4 text-sm text-gold">View the full breakdown →</div>
      </Link>

      <Link
        href="/app/admin/calendar"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Calendar</div>
        <div className="mt-1.5 text-sm text-ink-secondary">
          Who has the laser, this week and any other — every provider on one timeline
        </div>
        <div className="mt-4 text-sm text-gold">Open the calendar →</div>
      </Link>

      <Link
        href="/app/admin/equipment"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Equipment</div>
        <div className="mt-1.5 text-sm text-ink-secondary">
          The laser, photographed by whoever had it — and the sessions nobody accounted for
        </div>
        <div className="mt-4 text-sm text-gold">Check the laser →</div>
      </Link>

      <Link
        href="/app/admin/queue"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Queue</div>
        <div className="mt-1.5 text-sm text-ink-secondary">
          Money waiting on a decision — late room cancellations, fees that failed to charge,
          deposits on cancelled courses
        </div>
        <div className="mt-4 text-sm text-gold">Open the queue →</div>
      </Link>

      <Link
        href="/app/admin/training"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Training</div>
        <div className="mt-1.5 text-sm text-ink-secondary">
          Schedule courses, track enrolments, and chase the balances students still owe
        </div>
        <div className="mt-4 text-sm text-gold">Open training →</div>
      </Link>

      <Link
        href="/app/admin/tools"
        className="block rounded-card border border-line bg-surface p-6 transition-colors hover:border-line-strong"
      >
        <div className="text-xs uppercase tracking-wide text-ink-muted">Tools</div>
        <div className="mt-1.5 text-sm text-ink-secondary">
          Record a Cherry, Groupon, cash or check payment · log medical direction paid directly ·
          add an appointment on a provider&rsquo;s behalf
        </div>
        <div className="mt-4 text-sm text-gold">Open tools →</div>
      </Link>

      {/* v1's /app/admin carried the calendar, training links, training balances, room
          rentals, a cancellation queue and package sales in a single footer box. Those are
          distinct jobs and get distinct surfaces here — see Phase 6 in the migration plan. */}
      <p className="text-xs text-ink-faint">
        Room rental admin views are not built yet.
      </p>
    </main>
  )
}
