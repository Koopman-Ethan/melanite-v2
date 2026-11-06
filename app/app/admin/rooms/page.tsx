import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import { addDays, denverToday, weekStartOf } from '@/lib/db/queries/admin-calendar'
import {
  getDepositsToDecide,
  getLiveLeases,
  getRoomWeek,
  getTenantOptions,
} from '@/lib/db/queries/rooms'
import { ROOM_SLOT_LABELS } from '@/lib/email'
import { cn } from '@/lib/cn'

import { DepositDecision, RunningLease, StartLease } from './lease-panel'

export const metadata: Metadata = { title: 'Rooms · Melanite Admin' }
export const dynamic = 'force-dynamic'

// Every rentable space, one week at a time.
//
// Separate from the laser calendar on purpose (4 November): a room or a nail station has nothing
// to do with the laser, and the one room there used to be sat in a band across the top of it.
// Rows are spaces and columns are days — the question asked of this page is "who has what", not
// "what happens at 2pm".
//
// A monthly space's row is its lease: who has it, and what Keoni can do about it. Leases are hers
// to start — monthly rooms are a contract separate from the laser, and nobody applies for one.

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  })

const dayHeading = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return {
    weekday: at.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    date: at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  }
}

const navLink =
  'rounded-field border border-line px-3 py-2 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink-secondary'

export default async function AdminRoomsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  await requireAdmin()
  const params = await searchParams

  const today = denverToday()
  // Anything unparseable falls back to this week, as on the laser calendar.
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params.week ?? '') ? params.week! : today
  const weekStart = weekStartOf(requested)
  const isCurrentWeek = weekStart === weekStartOf(today)

  const [{ days, rooms, rentals }, leases, deposits, tenants] = await Promise.all([
    getRoomWeek(weekStart),
    getLiveLeases(),
    getDepositsToDecide(),
    getTenantOptions(),
  ])
  // Somebody already on a running lease is not offered a second space.
  const leased = new Set(leases.map((l) => l.providerId))
  const available = tenants.filter((t) => !leased.has(t.id))

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Rooms</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Who has each room and station this week. The laser has its own calendar.
          </p>
        </div>

        <nav className="flex items-center gap-1.5">
          <Link href={`/app/admin/rooms?week=${addDays(weekStart, -7)}`} className={navLink}>
            ← Previous
          </Link>
          <Link
            href="/app/admin/rooms"
            aria-current={isCurrentWeek ? 'page' : undefined}
            className={
              isCurrentWeek
                ? 'rounded-field border border-gold bg-gold/10 px-3 py-2 text-xs text-gold'
                : navLink
            }
          >
            This week
          </Link>
          <Link href={`/app/admin/rooms?week=${addDays(weekStart, 7)}`} className={navLink}>
            Next →
          </Link>
        </nav>
      </header>

      <div
        tabIndex={0}
        role="region"
        aria-label="Weekly room calendar"
        className="overflow-x-auto rounded-card border border-line bg-surface"
      >
        <table className="w-full min-w-[760px] table-fixed text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="w-44 p-3 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                Space
              </th>
              {days.map((day) => {
                const { weekday, date } = dayHeading(day)
                return (
                  <th
                    key={day}
                    className={cn(
                      'border-l border-line p-2 text-center text-xs font-normal',
                      day === today ? 'bg-gold/5 text-gold' : 'text-ink-muted',
                    )}
                  >
                    <div className="uppercase tracking-wide">{weekday}</div>
                    <div className="tabular-nums">{date}</div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rooms.map((room) => (
              <tr key={room.id}>
                <th scope="row" className="p-3 text-left align-top font-normal">
                  <div className="font-medium">{room.name}</div>
                  <div className="mt-0.5 text-xs text-ink-faint">
                    {room.kind === 'daily'
                      ? 'By the day'
                      : `${usd(room.monthlyPriceCents ?? 0)} / month`}
                  </div>
                </th>

                {room.kind === 'monthly' ? (
                  // One cell across the week: a monthly let is not a per-day fact.
                  <td colSpan={7} className="border-l border-line p-3 align-middle">
                    {(() => {
                      const lease = leases.find((l) => l.roomId === room.id)
                      return lease ? (
                        <RunningLease lease={lease} today={today} />
                      ) : (
                        <div className="space-y-1">
                          <span className="block text-xs text-ink-faint">Open</span>
                          <StartLease
                            roomId={room.id}
                            monthlyCents={room.monthlyPriceCents ?? 0}
                            tenants={available}
                            today={today}
                          />
                        </div>
                      )
                    })()}
                  </td>
                ) : (
                  days.map((day) => (
                    <td
                      key={day}
                      className={cn(
                        'h-16 border-l border-line p-1 align-top',
                        day === today && 'bg-gold/5',
                      )}
                    >
                      {rentals
                        .filter((r) => r.roomId === room.id && r.day === day)
                        .map((r) => (
                          <div
                            key={r.id}
                            className="mb-1 rounded-field border border-gold/40 bg-gold/10 px-1.5 py-1 last:mb-0"
                          >
                            <div className="truncate text-[10px] font-medium text-gold">
                              {ROOM_SLOT_LABELS[r.slotType]}
                            </div>
                            <div className="truncate text-[10px] text-ink-secondary">
                              {r.providerName}
                            </div>
                            {/* Said in words: a hold is not a confirmed let. */}
                            {r.status === 'pending' && (
                              <div className="text-[9px] text-warning">holding</div>
                            )}
                          </div>
                        ))}
                    </td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deposits.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            Deposits to decide
          </h2>
          <ul className="space-y-2">
            {deposits.map((lease) => (
              <DepositDecision key={lease.id} lease={lease} />
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
