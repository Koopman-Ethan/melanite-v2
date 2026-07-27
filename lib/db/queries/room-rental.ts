import 'server-only'

import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { platformSettings, roomBookings } from '@/lib/db/schema'

import { denverInstant } from './availability'

// Daily room rental.
//
// Distinct from laser booking in the direction the money flows: the PROVIDER pays Melanite for
// the space, so there is no split and no Connect transfer — `payer = 'provider'`, and the whole
// amount is `melaniteCut`. Confusing the two is how v1's room revenue ended up in its own
// parallel `room_transactions` table with a different column vocabulary.

export type SlotType = 'full' | 'am' | 'pm'

/** Statuses that occupy the room. Mirrors the `room_bookings_no_overlap` constraint — if these
 *  two ever disagree, the UI offers a slot the database then refuses. */
export const HOLDING_STATUSES = ['pending', 'confirmed'] as const

export interface RoomSettings {
  enabled: boolean
  fullDayPrice: string
  halfDayPrice: string
  amStart: string
  amEnd: string
  pmEnd: string
  advanceDays: number
}

export async function getRoomSettings(): Promise<RoomSettings> {
  const [row] = await db
    .select({
      enabled: platformSettings.roomRentalEnabled,
      fullDayPrice: platformSettings.roomFullDayPrice,
      halfDayPrice: platformSettings.roomHalfDayPrice,
      amStart: platformSettings.roomAmStart,
      amEnd: platformSettings.roomAmEnd,
      pmEnd: platformSettings.roomPmEnd,
      advanceDays: platformSettings.roomAdvanceDays,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return (
    row ?? {
      enabled: false,
      fullDayPrice: '100.00',
      halfDayPrice: '60.00',
      amStart: '08:00',
      amEnd: '13:00',
      pmEnd: '18:00',
      advanceDays: 60,
    }
  )
}

/** Denver wall-clock bounds for a slot on a given date. One definition, used by the availability
 *  read, the booking write and the display — a second one would drift from the constraint. */
export function slotBounds(
  date: string,
  slot: SlotType,
  settings: RoomSettings,
): { startAt: Date; endAt: Date } {
  const [open, close] =
    slot === 'am'
      ? [settings.amStart, settings.amEnd]
      : slot === 'pm'
        ? [settings.amEnd, settings.pmEnd]
        : [settings.amStart, settings.pmEnd]

  return { startAt: denverInstant(date, open), endAt: denverInstant(date, close) }
}

export function slotPrice(slot: SlotType, settings: RoomSettings): string {
  return slot === 'full' ? settings.fullDayPrice : settings.halfDayPrice
}

export interface DayOccupancy {
  date: string
  /** Which slots are still purchasable. Derived from actual occupied ranges rather than from
   *  slot names, so a `full` booking correctly closes `am` and `pm` too. */
  open: SlotType[]
  /** True when someone else already has part or all of the day. */
  partiallyTaken: boolean
  /** The provider's own holding rows, so the calendar can show "yours" rather than "taken". */
  mine: SlotType[]
  past: boolean
}

/** Occupancy for a month, for the rental calendar.
 *
 *  Expired holds are ignored here so an abandoned checkout stops blocking the slot visually.
 *  The database is the authority — `releaseExpiredHolds` is what actually frees it, and this
 *  read agrees with it rather than showing a slot the constraint would still refuse. */
export async function getMonthOccupancy(
  month: string,
  providerId: string,
  settings: RoomSettings,
  now: Date = new Date(),
): Promise<DayOccupancy[]> {
  const [year, mo] = month.split('-').map(Number)
  const dayCount = new Date(Date.UTC(year, mo, 0)).getUTCDate()
  const dates = Array.from(
    { length: dayCount },
    (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`,
  )

  const rows = await db
    .select({
      providerId: roomBookings.providerId,
      startAt: roomBookings.startAt,
      endAt: roomBookings.endAt,
      slotType: roomBookings.slotType,
      rentalDate: roomBookings.rentalDate,
    })
    .from(roomBookings)
    .where(
      and(
        gte(roomBookings.rentalDate, dates[0]),
        lte(roomBookings.rentalDate, dates[dayCount - 1]),
        inArray(roomBookings.status, [...HOLDING_STATUSES]),
        // A pending row past its hold no longer occupies anything.
        or(
          eq(roomBookings.status, 'confirmed'),
          sql`${roomBookings.holdExpiresAt} > ${now.toISOString()}`,
        ),
      ),
    )

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now)

  return dates.map((date) => {
    const taken = rows.filter((r) => r.rentalDate === date)
    const open: SlotType[] = []
    const mine: SlotType[] = []

    for (const slot of ['full', 'am', 'pm'] as const) {
      const { startAt, endAt } = slotBounds(date, slot, settings)
      const clash = taken.find((r) => r.startAt < endAt && r.endAt > startAt)
      if (!clash) open.push(slot)
      if (clash?.providerId === providerId && !mine.includes(clash.slotType)) {
        mine.push(clash.slotType)
      }
    }

    return {
      date,
      open: date < today ? [] : open,
      partiallyTaken: taken.length > 0,
      mine,
      past: date < today,
    }
  })
}

export interface MyRental {
  id: string
  rentalDate: string
  slotType: SlotType
  price: string
  status: string
  startAt: Date
  endAt: Date
  cancelledAt: Date | null
  stripePaymentIntentId: string | null
  /** Hours until the block starts. Computed here rather than in the page: the 24-hour refund
   *  boundary should be measured against a single instant, and reading the clock during a
   *  render is impure. */
  hoursOut: number
}

export async function getMyRentals(
  providerId: string,
  limit = 40,
  now: Date = new Date(),
): Promise<MyRental[]> {
  const rows = await db
    .select({
      id: roomBookings.id,
      rentalDate: roomBookings.rentalDate,
      slotType: roomBookings.slotType,
      price: roomBookings.price,
      status: roomBookings.status,
      startAt: roomBookings.startAt,
      endAt: roomBookings.endAt,
      cancelledAt: roomBookings.cancelledAt,
      stripePaymentIntentId: roomBookings.stripePaymentIntentId,
    })
    .from(roomBookings)
    .where(
      and(
        eq(roomBookings.providerId, providerId),
        // Abandoned holds are noise, not history.
        sql`(${roomBookings.status} <> 'pending' OR ${roomBookings.holdExpiresAt} > now())`,
      ),
    )
    .orderBy(desc(roomBookings.rentalDate), asc(roomBookings.startAt))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    hoursOut: (r.startAt.getTime() - now.getTime()) / 3_600_000,
  }))
}

/** Drops holds whose checkout was abandoned.
 *
 *  Called before any availability read or write rather than on a schedule: there is no cron in
 *  this stack yet, and a stale hold that only clears on someone else's page load is still
 *  cleared before it can affect them. */
export async function releaseExpiredHolds(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE room_bookings
       SET status = 'cancelled', cancelled_at = now()
     WHERE status = 'pending'
       AND hold_expires_at IS NOT NULL
       AND hold_expires_at < now()
    RETURNING id
  `)
  return result.rows?.length ?? 0
}
