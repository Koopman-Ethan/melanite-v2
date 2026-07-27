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
  const dayBookings = await db
    .select({ startTime: bookings.startTime, endTime: bookings.endTime })
    .from(bookings)
    .where(
      and(
        gt(bookings.endTime, open),
        lt(bookings.startTime, close),
        inArray(bookings.status, [...OCCUPYING_STATUSES]),
      ),
    )

  const strideMs = hours.strideMins * 60_000
  const durationMs = durationMins * 60_000
  const slots: Slot[] = []

  for (let t = open.getTime(); t < close.getTime(); t += strideMs) {
    const startTime = new Date(t)
    const endTime = new Date(t + durationMs)

    let reason: Slot['reason']
    if (endTime > close) reason = 'after-hours'
    else if (startTime <= now) reason = 'past'
    else if (dayBookings.some((b) => b.startTime < endTime && b.endTime > startTime)) {
      reason = 'taken'
    }

    slots.push({ startTime, endTime, available: !reason, reason })
  }

  return { slots, hours }
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
