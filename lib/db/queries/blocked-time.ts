import 'server-only'

import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import { blockedTime, bookings, providerServices, providers, services } from '@/lib/db/schema'

// Laser time Melanite has taken out of service.
//
// The read and write side of `blocked_time`. The availability grid reads it through
// `blockedBetween` in `availability.ts`; every insert that takes laser time refuses it through
// `overlapsBlockedTime`. This is what the admin screen uses.
//
// A block is NOT a booking, and the difference is the point. Before this existed, closing an
// afternoon meant inventing an appointment — which needed a provider, a service, a client name
// and a price, each of which lied to a different report — or inventing a training course, which
// is worse, because a course is publicly enrollable and a stranger can pay a deposit against it.

export interface BlockedWindow {
  id: string
  startTime: Date
  endTime: Date
  /** Melanite's own note. Never shown to a provider. */
  reason: string | null
  createdBy: string | null
  createdByName: string | null
}

/** Blocks from now onward, soonest first. Past ones are history and nobody can act on them. */
export async function getUpcomingBlocks(limit = 50): Promise<BlockedWindow[]> {
  const rows = await db
    .select({
      id: blockedTime.id,
      startTime: blockedTime.startTime,
      endTime: blockedTime.endTime,
      reason: blockedTime.reason,
      createdBy: blockedTime.createdBy,
      createdByName: sql<
        string | null
      >`${providers.firstName} || ' ' || ${providers.lastName}`,
    })
    .from(blockedTime)
    .leftJoin(providers, eq(providers.id, blockedTime.createdBy))
    .where(gte(blockedTime.endTime, new Date()))
    .orderBy(asc(blockedTime.startTime))
    .limit(limit)

  return rows
}

export interface BookingConflict {
  clientName: string
  providerName: string
  serviceName: string
  startTime: Date
}

/**
 * Appointments inside a window somebody is about to block.
 *
 * The same guard `createCourse` applies through `bookingsDuringCourse`, and for the same
 * reason: blocking time that is already booked would leave the appointment standing while
 * whoever blocked it believes the room is shut. The database cannot catch this — `blocked_time`
 * and `bookings` are different tables, so there is no constraint between them — which makes
 * this check the only thing standing in the way.
 */
export async function bookingsDuringBlock(start: Date, end: Date): Promise<BookingConflict[]> {
  const rows = await db
    .select({
      clientName: bookings.clientName,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      serviceName: services.name,
      startTime: bookings.startTime,
    })
    .from(bookings)
    .innerJoin(providers, eq(providers.id, bookings.providerId))
    .innerJoin(providerServices, eq(providerServices.id, bookings.providerServiceId))
    .innerJoin(services, eq(services.id, providerServices.serviceId))
    .where(
      and(
        inArray(bookings.status, ['upcoming', 'completed']),
        lt(bookings.startTime, end),
        gt(bookings.endTime, start),
      ),
    )
    .orderBy(asc(bookings.startTime))

  return rows.map((r) => ({ ...r, clientName: clientLabel(r.clientName) }))
}

/** Names what is in the way, rather than saying there is a conflict.
 *
 *  Mirrors `courseConflictMessage`. "Something is booked then" sends somebody to the calendar to
 *  hunt; this tells them which appointment to deal with. */
export function blockConflictMessage(conflicts: BookingConflict[]): string {
  const when = (d: Date) =>
    d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Denver',
    })

  const listed = conflicts
    .slice(0, 4)
    .map((c) => `${c.serviceName} with ${c.providerName}, ${when(c.startTime)}`)
    .join('; ')

  const more = conflicts.length > 4 ? ` and ${conflicts.length - 4} more` : ''

  return `That time is already booked — ${listed}${more}. Move or cancel it first.`
}

export type BlockResult = { id: string } | { error: string }

/**
 * Takes a window of laser time out of service.
 *
 * Overlapping an existing BLOCK is allowed and does nothing surprising: blocking 12:00–14:00 and
 * then 13:00–15:00 shuts the laser from 12:00 to 15:00, which is what somebody doing that meant.
 * Overlapping a BOOKING is refused, because that would silently leave the appointment standing.
 */
export async function blockTime(input: {
  start: Date
  end: Date
  reason: string | null
  createdBy: string
}): Promise<BlockResult> {
  if (!(input.end > input.start)) {
    return { error: 'The end has to be after the start.' }
  }

  const conflicts = await bookingsDuringBlock(input.start, input.end)
  if (conflicts.length > 0) {
    return { error: blockConflictMessage(conflicts) }
  }

  const [row] = await db
    .insert(blockedTime)
    .values({
      startTime: input.start,
      endTime: input.end,
      reason: input.reason?.trim() || null,
      createdBy: input.createdBy,
    })
    .returning({ id: blockedTime.id })

  return { id: row.id }
}

/** Reopens a blocked window.
 *
 *  A hard delete, unlike a cancelled booking. A booking that was cancelled is a fact about
 *  somebody's appointment and has to survive; a block that was lifted is just time that is
 *  available again, and keeping a tombstone for it would only make the admin list harder to
 *  read. */
export async function unblockTime(id: string): Promise<{ removed: boolean }> {
  const rows = await db
    .delete(blockedTime)
    .where(eq(blockedTime.id, id))
    .returning({ id: blockedTime.id })

  return { removed: rows.length > 0 }
}
