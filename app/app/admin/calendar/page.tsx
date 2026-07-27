import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import {
  addDays,
  currentBooking,
  denverToday,
  getCalendarWeek,
  nextBooking,
  weekStartOf,
} from '@/lib/db/queries/admin-calendar'

import { WeekGrid } from './week-grid'

export const metadata: Metadata = { title: 'Calendar · Melanite Admin' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const hoursLabel = (minutes: number) => `${(minutes / 60).toFixed(1)}h`

/** "Jun 14 – 20, 2026", "Jul 26 – Aug 1, 2026", "Dec 28, 2025 – Jan 3, 2026".
 *
 *  Assembled from parts rather than asking Intl for a partial date: requesting year and day
 *  without a month is a combination en-US has no pattern for, and ICU falls back to
 *  "2026 (day: 20)". */
const rangeLabel = (days: string[]) => {
  const at = (day: string) => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d))
  }
  const first = at(days[0])
  const last = at(days[6])
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })

  const firstYear = first.getUTCFullYear()
  const lastYear = last.getUTCFullYear()

  if (firstYear !== lastYear) {
    return `${month(first)} ${first.getUTCDate()}, ${firstYear} – ${month(last)} ${last.getUTCDate()}, ${lastYear}`
  }
  if (first.getUTCMonth() !== last.getUTCMonth()) {
    return `${month(first)} ${first.getUTCDate()} – ${month(last)} ${last.getUTCDate()}, ${lastYear}`
  }
  return `${month(first)} ${first.getUTCDate()} – ${last.getUTCDate()}, ${lastYear}`
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line p-4">
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  )
}

export default async function AdminCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  await requireAdmin()
  const params = await searchParams

  const today = denverToday()
  // Anything unparseable falls back to this week rather than erroring — a hand-edited URL
  // should not be able to break the page.
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params.week ?? '') ? params.week! : today
  const weekStart = weekStartOf(requested)

  const week = await getCalendarWeek(weekStart)
  const { stats } = week

  const now = currentBooking(week)
  const next = now ? null : nextBooking(week)
  const utilization = stats.openMinutes > 0 ? (stats.bookedMinutes / stats.openMinutes) * 100 : 0
  const isCurrentWeek = weekStart === weekStartOf(today)

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {rangeLabel(week.days)} · every provider on the shared laser
          </p>
        </div>

        <nav className="flex items-center gap-1.5">
          <Link
            href={`/app/admin/calendar?week=${addDays(weekStart, -7)}`}
            className="rounded-field border border-line px-3 py-2 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink-secondary"
          >
            ← Previous
          </Link>
          <Link
            href="/app/admin/calendar"
            aria-current={isCurrentWeek ? 'page' : undefined}
            className={
              isCurrentWeek
                ? 'rounded-field border border-gold bg-gold/10 px-3 py-2 text-xs text-gold'
                : 'rounded-field border border-line px-3 py-2 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink-secondary'
            }
          >
            This week
          </Link>
          <Link
            href={`/app/admin/calendar?week=${addDays(weekStart, 7)}`}
            className="rounded-field border border-line px-3 py-2 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink-secondary"
          >
            Next →
          </Link>
        </nav>
      </header>

      {/* Answers "who has it right now" without reading the grid — the question an admin
          actually walks up to this page with. Only meaningful on the current week. */}
      {isCurrentWeek && (
        <div className="rounded-card border border-line bg-surface p-5">
          {now ? (
            <>
              <div className="text-xs uppercase tracking-wide text-ink-muted">On the laser now</div>
              <div className="mt-1.5 text-lg font-medium">
                {now.providerName}
                <span className="text-ink-muted"> · {now.clientName}</span>
              </div>
              <div className="mt-0.5 text-sm text-ink-faint tabular-nums">
                {now.serviceName} · until {now.endLabel}
              </div>
            </>
          ) : next ? (
            <>
              <div className="text-xs uppercase tracking-wide text-ink-muted">Laser is free</div>
              <div className="mt-1.5 text-sm text-ink-secondary">
                Next up: {next.providerName} with {next.clientName} at{' '}
                <span className="tabular-nums">{next.startLabel}</span>
                {next.day !== denverToday() && (
                  <span className="text-ink-faint">
                    {' '}
                    on{' '}
                    {new Date(`${next.day}T12:00:00Z`).toLocaleDateString('en-US', {
                      weekday: 'long',
                      timeZone: 'UTC',
                    })}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="text-xs uppercase tracking-wide text-ink-muted">Laser is free</div>
              <div className="mt-1.5 text-sm text-ink-secondary">
                Nothing else booked this week.
              </div>
            </>
          )}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Appointments"
          value={String(stats.booked)}
          hint={stats.cancelled > 0 ? `${stats.cancelled} cancelled or no-show` : undefined}
        />
        <Stat
          label="Laser time"
          value={hoursLabel(stats.bookedMinutes)}
          hint={`${utilization.toFixed(0)}% of ${hoursLabel(stats.openMinutes)} open`}
        />
        <Stat label="Booked value" value={usd(stats.revenue)} hint="at the discounted price" />
        <Stat
          label="Providers"
          value={String(stats.providers)}
          hint={stats.providers === 1 ? 'on the laser this week' : 'sharing the laser'}
        />
      </section>

      {/* On a single-laser business this cannot legitimately happen, so it is surfaced rather
          than quietly drawn. Two blocks side by side would otherwise read as normal. */}
      {stats.doubleBooked > 0 && (
        <p
          role="alert"
          className="rounded-field border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {stats.doubleBooked} appointments overlap another. There is one laser — these cannot
          both happen.
        </p>
      )}

      <WeekGrid
        days={week.days}
        bookings={week.bookings}
        openTime={week.hours.openTime}
        closeTime={week.hours.closeTime}
      />
    </main>
  )
}
