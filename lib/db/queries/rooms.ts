import 'server-only'

import { and, asc, eq, gte, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { addDays } from '@/lib/db/queries/admin-calendar'
import { providers, roomBookings, rooms } from '@/lib/db/schema'

// The rentable spaces (migration 0048).
//
// One of them is rented by the day and the rest by the month. The daily room keeps everything it
// had before there was more than one room — its own page, its half-day and full-day prices in
// `platform_settings` — and only gained a name.

/** The room the per-day booking flow rents. Every room booking written before 0048 is this one,
 *  and it is `room_bookings.room_id`'s default. */
export const DAILY_ROOM_ID = 'daily'

export interface Room {
  id: string
  name: string
  kind: 'daily' | 'monthly'
  monthlyPriceCents: number | null
}

/** Every space still offered, in Keoni's order. */
export async function getRooms(): Promise<Room[]> {
  return db
    .select({
      id: rooms.id,
      name: rooms.name,
      kind: rooms.kind,
      monthlyPriceCents: rooms.monthlyPriceCents,
    })
    .from(rooms)
    .where(eq(rooms.active, true))
    .orderBy(asc(rooms.sort), asc(rooms.name))
}

/** A day, or half a day, a space is let to a provider. */
export interface RoomRentalEntry {
  id: string
  roomId: string
  day: string
  slotType: 'full' | 'am' | 'pm'
  providerName: string
  status: string
}

/** One week of every space, for Keoni's room calendar.
 *
 *  The rooms used to be a band across the top of the LASER calendar — which was right while there
 *  was one room and nothing else to show, and wrong once there were six spaces that have nothing
 *  to do with the laser (4 November). They have their own page now.
 *
 *  Fetched by rental_date rather than by timestamp range: a day room is sold as a named slot, and
 *  its start/end are derived from platform settings that can change. The date is what was bought. */
export async function getRoomWeek(
  weekStart: string,
): Promise<{ days: string[]; rooms: Room[]; rentals: RoomRentalEntry[] }> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const [spaces, rows] = await Promise.all([
    getRooms(),
    db
      .select({
        id: roomBookings.id,
        roomId: roomBookings.roomId,
        day: roomBookings.rentalDate,
        slotType: roomBookings.slotType,
        status: roomBookings.status,
        firstName: providers.firstName,
        lastName: providers.lastName,
      })
      .from(roomBookings)
      .innerJoin(providers, eq(roomBookings.providerId, providers.id))
      .where(
        and(
          gte(roomBookings.rentalDate, weekStart),
          lt(roomBookings.rentalDate, addDays(weekStart, 7)),
        ),
      )
      .orderBy(asc(roomBookings.rentalDate), asc(roomBookings.startAt)),
  ])

  const rentals = rows
    // A pending hold is someone mid-checkout, which is worth seeing — an abandoned one expires
    // and disappears on its own. A cancelled or refunded rental is not.
    .filter((r) => r.status !== 'cancelled' && r.status !== 'refunded')
    .map((r) => ({
      id: r.id,
      roomId: r.roomId,
      day: r.day,
      slotType: r.slotType,
      status: r.status,
      providerName: `${r.firstName} ${r.lastName}`,
    }))

  return { days, rooms: spaces, rentals }
}
