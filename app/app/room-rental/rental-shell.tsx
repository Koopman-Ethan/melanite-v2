'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import type { DayOccupancy } from '@/lib/db/queries/room-rental'

import { RentalPanel, type RentalView } from './rental-panel'

/** Keeps the browsed month in the URL so occupancy is recomputed on the server.
 *
 *  Same reasoning as the booking page: the room is a shared resource, so another provider's
 *  reservation has to appear without this page having fetched it. A month held in client state
 *  would go stale silently.
 */
export function RentalShell({
  month,
  days,
  today,
  rentals,
  canBook,
  fullDayPrice,
  halfDayPrice,
  amStart,
  amEnd,
  pmEnd,
}: {
  month: string
  days: DayOccupancy[]
  today: string
  rentals: RentalView[]
  canBook: boolean
  fullDayPrice: string
  halfDayPrice: string
  amStart: string
  amEnd: string
  pmEnd: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  return (
    <RentalPanel
      month={month}
      // A blocked provider still sees the calendar — it is the only way to know whether the
      // room is worth chasing access for — but every day is unselectable.
      days={canBook ? days : days.map((d) => ({ ...d, open: [] }))}
      today={today}
      rentals={rentals}
      fullDayPrice={fullDayPrice}
      halfDayPrice={halfDayPrice}
      amStart={amStart}
      amEnd={amEnd}
      pmEnd={pmEnd}
      onMonthChange={(m) => {
        const next = new URLSearchParams(params)
        next.set('month', m)
        // Drops ?paid / ?cancelled on navigation so the banner does not follow the provider
        // around the calendar.
        next.delete('paid')
        next.delete('cancelled')
        router.push(`${pathname}?${next}`, { scroll: false })
      }}
    />
  )
}
