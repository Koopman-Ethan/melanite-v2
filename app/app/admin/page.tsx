import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import { getRevenueTotals } from '@/lib/db/queries/revenue'

export const metadata: Metadata = { title: 'Admin · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function AdminHome() {
  const user = await requireAdmin()
  const totals = await getRevenueTotals()

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Welcome back, {user.firstName}</h1>
        <p className="mt-1 text-sm text-ink-muted">Platform overview</p>
      </header>

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
        Training, room rentals and the cancellation queue are not built yet.
      </p>
    </main>
  )
}
