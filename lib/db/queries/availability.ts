import 'server-only'

import { and, eq, gt, inArray, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, platformSettings, providerServices, services } from '@/lib/db/schema'

// Availability for the single shared laser.
//
// GLOBAL, not per-provider — any provider's booking blocks the slot for everyone. That is the
// central fact about this business and the easiest thing to get wrong, because every other
// query on the site is scoped to the caller.
//
// Only `upcoming` and `completed` bookings occupy a slot. A cancelled or no-show booking frees
// it, which is what lets a cancelled package session be rebooked as if it never happened.

const OCCUPYING_STATUSES = ['upcoming', 'completed'] as const

export interface Slot {
  /** Absolute instant the slot begins. */
  startTime: Date
  endTime: Date
  available: boolean
  /** Why not, when unavailable — v1 returned a bare boolean, so the UI could not explain
   *  itself and every greyed-out slot looked like the same problem. */
  reason?: 'taken' | 'past' | 'after-hours'
}

export interface LaserHours {
  openTime: string
  closeTime: string
  strideMins: number
}

export async function getLaserHours(): Promise<LaserHours> {
  const [settings] = await db
    .select({
      openTime: platformSettings.laserOpenTime,
      closeTime: platformSettings.laserCloseTime,
      strideMins: platformSettings.slotStrideMins,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return settings ?? { openTime: '08:00', closeTime: '20:00', strideMins: 15 }
}

/** Builds the instant for a `YYYY-MM-DD` + `HH:MM` in America/Denver.
 *
 *  Done by measuring the zone's offset on that date rather than assuming one: Mountain Time
 *  is UTC-7 in summer and UTC-6 in winter, so a fixed offset silently shifts every slot by an
 *  hour for half the year. */
export function denverInstant(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)

  // Start from the naive wall-clock reading as if it were UTC, then correct by the offset the
  // zone actually had at that moment.
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  const probe = new Date(asUtc)
  const local = new Date(probe.toLocaleString('en-US', { timeZone: 'America/Denver' }))
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(asUtc + (utc.getTime() - local.getTime()))
}

interface Occupied {
  startTime: Date
  endTime: Date
}

/** The slot loop for one day. Shared by the day view and the month calendar so the count on a
 *  calendar cell cannot disagree with the grid it opens — two implementations of "how many
 *  slots are free" is how a calendar ends up promising a day that turns out to be full. */
function buildSlots(
  open: Date,
  close: Date,
  strideMins: number,
  durationMins: number,
  occupied: Occupied[],
  now: Date,
): Slot[] {
  const strideMs = strideMins * 60_000
  const durationMs = durationMins * 60_000
  const slots: Slot[] = []

  for (let t = open.getTime(); t < close.getTime(); t += strideMs) {
    const startTime = new Date(t)
    const endTime = new Date(t + durationMs)

    let reason: Slot['reason']
    if (endTime > close) reason = 'after-hours'
    else if (startTime <= now) reason = 'past'
    else if (occupied.some((b) => b.startTime < endTime && b.endTime > startTime)) {
      reason = 'taken'
    }

    slots.push({ startTime, endTime, available: !reason, reason })
  }

  return slots
}

async function occupyingBetween(from: Date, to: Date): Promise<Occupied[]> {
  return db
    .select({ startTime: bookings.startTime, endTime: bookings.endTime })
    .from(bookings)
    .where(
      and(
        gt(bookings.endTime, from),
        lt(bookings.startTime, to),
        inArray(bookings.status, [...OCCUPYING_STATUSES]),
      ),
    )
}

export async function getAvailability(
  date: string,
  durationMins: number,
  now: Date = new Date(),
): Promise<{ slots: Slot[]; hours: LaserHours }> {
  if (!Number.isInteger(durationMins) || durationMins <= 0) {
    throw new Error('duration must be a positive whole number of minutes')
  }

  const hours = await getLaserHours()
  const open = denverInstant(date, hours.openTime)
  const close = denverInstant(date, hours.closeTime)

  // Every booking overlapping the day's window, across ALL providers.
  const dayBookings = await occupyingBetween(open, close)

  return {
    slots: buildSlots(open, close, hours.strideMins, durationMins, dayBookings, now),
    hours,
  }
}

export interface DayAvailability {
  date: string
  openSlots: number
  /** Slots that would fit the service if nothing were booked — the denominator for "how full
   *  is this day", and it shrinks as the service gets longer. */
  fittingSlots: number
  past: boolean
}

/** Openings for every day of a month, for the booking calendar.
 *
 *  The point is that a provider should not have to click through dates one at a time to find
 *  out which are usable. On a shared laser that is a real cost: the day you want may be full
 *  because of someone else entirely, and nothing on a bare date field says so.
 *
 *  Counts are duration-specific. A 30-minute service and a two-hour one see genuinely
 *  different calendars, which is why this takes the duration rather than reporting a generic
 *  "busy" score. */
export async function getMonthAvailability(
  month: string,
  durationMins: number,
  now: Date = new Date(),
): Promise<{ days: DayAvailability[]; hours: LaserHours }> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM')
  if (!Number.isInteger(durationMins) || durationMins <= 0) {
    throw new Error('duration must be a positive whole number of minutes')
  }

  const hours = await getLaserHours()
  const [year, mo] = month.split('-').map(Number)
  const dayCount = new Date(Date.UTC(year, mo, 0)).getUTCDate()

  const dates = Array.from(
    { length: dayCount },
    (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`,
  )

  // One query for the whole month rather than one per day.
  const monthBookings = await occupyingBetween(
    denverInstant(dates[0], hours.openTime),
    denverInstant(dates[dayCount - 1], hours.closeTime),
  )

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now)

  const days = dates.map((date) => {
    const open = denverInstant(date, hours.openTime)
    const close = denverInstant(date, hours.closeTime)
    const dayBookings = monthBookings.filter((b) => b.startTime < close && b.endTime > open)
    const slots = buildSlots(open, close, hours.strideMins, durationMins, dayBookings, now)

    return {
      date,
      openSlots: slots.filter((s) => s.available).length,
      fittingSlots: slots.filter((s) => s.reason !== 'after-hours').length,
      past: date < today,
    }
  })

  return { days, hours }
}

export interface BookableService {
  providerServiceId: string
  serviceId: string
  name: string
  price: string
  durationMins: number
  minDurationMins: number
  maxDurationMins: number
  colorHex: string | null
}

/** Services this provider can actually book right now.
 *
 *  Both `is_active` flags matter and mean different things: the provider's own toggle, and
 *  whether the service is still offered platform-wide. v1 checked them separately at create
 *  time with the same INVALID_SERVICE code; filtering here means an unbookable service is
 *  never offered in the first place. */
export async function getBookableServices(providerId: string): Promise<BookableService[]> {
  return db
    .select({
      providerServiceId: providerServices.id,
      serviceId: services.id,
      name: services.name,
      price: providerServices.price,
      durationMins: providerServices.durationMins,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      colorHex: services.colorHex,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.providerId, providerId),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )
    .orderBy(services.name)
}
