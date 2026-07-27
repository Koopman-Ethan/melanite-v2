import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { Notice } from '@/components/ui/field'
import {
  getMonthOccupancy,
  getMyRentals,
  getRoomSettings,
  releaseExpiredHolds,
} from '@/lib/db/queries/room-rental'

import { RentalShell } from './rental-shell'

export const metadata: Metadata = { title: 'Daily room rental · Melanite' }
export const dynamic = 'force-dynamic'

const todayInDenver = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())

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

  const [days, rentals] = await Promise.all([
    getMonthOccupancy(month, user.id, settings),
    getMyRentals(user.id),
  ])

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
        <h1 className="text-2xl font-semibold">Daily room rental</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Rent the treatment room by the day or half day. This is space only — it does not book
          the laser.
        </p>
      </header>

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
