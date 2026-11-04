import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { Notice } from '@/components/ui/field'
import { todayInDenver } from '@/lib/validation'
import {
  getMonthOccupancy,
  getMyRentals,
  getRoomSettings,
  releaseExpiredHolds,
} from '@/lib/db/queries/room-rental'
import { getRooms } from '@/lib/db/queries/rooms'

import { RentalShell } from './rental-shell'

export const metadata: Metadata = { title: 'Room rental · Melanite' }
export const dynamic = 'force-dynamic'


export default async function RoomRentalPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; paid?: string; cancelled?: string }>
}) {
  const user = await requireProvider()
  const params = await searchParams
  const settings = await getRoomSettings()

  const today = todayInDenver()
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : today.slice(0, 7)

  // Swept on read. There is no scheduler in this stack yet, and a hold that only clears when
  // someone looks at the page is still cleared before it can affect them.
  await releaseExpiredHolds()

  const [days, rentals, spaces] = await Promise.all([
    getMonthOccupancy(month, user.id, settings),
    getMyRentals(user.id),
    getRooms(),
  ])
  const monthly = spaces.filter((r) => r.kind === 'monthly')

  const blocked = !settings.enabled
    ? 'Room rental is not currently available. Melanite will announce it when it opens.'
    : !user.bookingEnabled
      ? 'Your account is not yet cleared. Melanite will enable it once your required documents are confirmed.'
      : !user.roomRentalEnabled
        ? 'Room rental is not available on your account. Contact Melanite.'
        : null

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Room rental</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Rent a treatment room or nail station by the month, or the daily room by the day or half
          day. This is space only — it does not book the laser.
        </p>
      </header>

      {/* Listed before they can be booked, deliberately. A provider asking "do you have a room
          by the month?" should find the answer here rather than a page that only knows about the
          daily room. How a monthly let starts and ends is waiting on Keoni (4 November); until
          then the honest instruction is to ask. */}
      {monthly.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">By the month</h2>
          <ul className="divide-y divide-line rounded-card border border-line">
            {monthly.map((room) => (
              <li key={room.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
                <span className="text-sm font-medium">{room.name}</span>
                <span className="text-sm tabular-nums text-ink-secondary">
                  {((room.monthlyPriceCents ?? 0) / 100).toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 0,
                  })}{' '}
                  / month
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-faint">
            Monthly rentals can&rsquo;t be booked here yet. To reserve one, contact Melanite.
          </p>
        </section>
      )}

      <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">The daily room</h2>

      {params.paid === '1' && (
        <Notice tone="success">
          Payment received. Your rental is confirmed as soon as Stripe reports it — refresh in a
          moment if it still shows as awaiting payment.
        </Notice>
      )}
      {params.cancelled === '1' && (
        <Notice tone="warning">
          Checkout cancelled. The block is released — nothing was charged.
        </Notice>
      )}

      {/* Shown rather than redirected. A provider sent away with no explanation learns nothing,
          and two of these three are things only Melanite can change. Past rentals stay visible
          regardless, since a revoked flag must not hide history. */}
      {blocked && <Notice tone="warning">{blocked}</Notice>}

      <RentalShell
        month={month}
        days={days}
        today={today}
        canBook={!blocked}
        rentals={rentals.map((r) => ({
          id: r.id,
          rentalDate: r.rentalDate,
          slotType: r.slotType,
          price: r.price,
          status: r.status,
          startAt: r.startAt.toISOString(),
          hoursOut: r.hoursOut,
        }))}
        fullDayPrice={settings.fullDayPrice}
        halfDayPrice={settings.halfDayPrice}
        amStart={settings.amStart}
        amEnd={settings.amEnd}
        pmEnd={settings.pmEnd}
      />
    </main>
  )
}
