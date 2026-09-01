import 'server-only'

import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  equipmentChecks,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'
import { afterCheckNeeded, checkWindowOpen } from '@/lib/equipment-checks'
import { EQUIPMENT_LOG_STARTED_AT } from '@/lib/equipment-policy'

// Reading the equipment record.
//
// Everything Keoni sees is DERIVED from the state of the bookings themselves — there is no stored
// work list, for the reason `/app/admin/queue` gives: a separate store is one more thing that can
// disagree with reality, and an item lingering after it has been dealt with is worse than no list
// at all. A gap closes here by a photograph existing, and by nothing else.

export interface EquipmentPhoto {
  id: string
  kind: 'before' | 'after'
  recordedAt: Date
  storageKey: string
  note: string | null
  needsAttention: boolean
  providerName: string
  /** Set when Melanite destroyed the photograph. The check itself still counts — see
   *  `equipmentChecks.photoDeletedAt` for why the row outlives the file. */
  photoDeletedAt: Date | null
}

/** Every photograph taken around one appointment, oldest first. */
export async function getChecksForBooking(bookingId: string): Promise<EquipmentPhoto[]> {
  return db
    .select({
      id: equipmentChecks.id,
      kind: equipmentChecks.kind,
      recordedAt: equipmentChecks.recordedAt,
      storageKey: equipmentChecks.storageKey,
      note: equipmentChecks.note,
      needsAttention: equipmentChecks.needsAttention,
      photoDeletedAt: equipmentChecks.photoDeletedAt,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
    })
    .from(equipmentChecks)
    .innerJoin(providers, eq(equipmentChecks.providerId, providers.id))
    .where(eq(equipmentChecks.bookingId, bookingId))
    .orderBy(asc(equipmentChecks.recordedAt))
}

export interface CheckPrompt {
  bookingId: string
  clientName: string
  serviceName: string
  startTime: Date
  endTime: Date
  hasBefore: boolean
  hasAfter: boolean
  /** False when somebody follows soon enough that their arrival photo brackets this session. */
  afterNeeded: boolean
}

/**
 * What this provider should be photographing right now.
 *
 * Scoped to their own bookings, but the "does anybody follow me" question is answered against
 * EVERY booking on the laser that day — it is one shared machine, so the next person to touch it
 * is very often somebody else.
 */
export async function getCheckPrompts(providerId: string): Promise<CheckPrompt[]> {
  const now = new Date()
  const dayStart = new Date(now)
  dayStart.setHours(dayStart.getHours() - 24)
  const dayEnd = new Date(now)
  dayEnd.setHours(dayEnd.getHours() + 24)

  const mine = await db
    .select({
      bookingId: bookings.id,
      clientName: bookings.clientName,
      serviceName: services.name,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      hasBefore: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'before'
      )`,
      hasAfter: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'after'
      )`,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(bookings.providerId, providerId),
        sql`${bookings.status} in ('upcoming', 'completed')`,
        gte(bookings.startTime, dayStart),
        lte(bookings.startTime, dayEnd),
      ),
    )
    .orderBy(asc(bookings.startTime))

  if (mine.length === 0) return []

  // The whole laser's day, not just this provider's — see the doc comment.
  const span = laserDay(mine[0].startTime)
  const sameDay = await db
    .select({ id: bookings.id, startTime: bookings.startTime, endTime: bookings.endTime })
    .from(bookings)
    .where(
      and(
        sql`${bookings.status} in ('upcoming', 'completed')`,
        gte(bookings.startTime, span.from),
        lt(bookings.startTime, span.to),
      ),
    )

  return mine
    .filter((b) => checkWindowOpen({ id: b.bookingId, startTime: b.startTime, endTime: b.endTime }, now))
    .map((b) => ({
      ...b,
      afterNeeded: afterCheckNeeded(
        { id: b.bookingId, startTime: b.startTime, endTime: b.endTime },
        sameDay,
      ),
    }))
}

/** Denver midnight-to-midnight around an instant. The business day, not the server's. */
function laserDay(instant: Date): { from: Date; to: Date } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(instant)
  const from = new Date(`${day}T00:00:00-06:00`)
  const to = new Date(from.getTime() + 24 * 60 * 60_000)
  return { from, to }
}

export interface FlaggedCheck {
  id: string
  bookingId: string
  kind: 'before' | 'after'
  recordedAt: Date
  storageKey: string
  note: string | null
  providerName: string
  startTime: Date
  serviceName: string
  photoDeletedAt: Date | null
}

/** Somebody said something is wrong. The top of Keoni's page. */
export async function getFlaggedChecks(): Promise<FlaggedCheck[]> {
  return db
    .select({
      id: equipmentChecks.id,
      bookingId: equipmentChecks.bookingId,
      kind: equipmentChecks.kind,
      recordedAt: equipmentChecks.recordedAt,
      storageKey: equipmentChecks.storageKey,
      note: equipmentChecks.note,
      photoDeletedAt: equipmentChecks.photoDeletedAt,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      startTime: bookings.startTime,
      serviceName: services.name,
    })
    .from(equipmentChecks)
    .innerJoin(providers, eq(equipmentChecks.providerId, providers.id))
    .innerJoin(bookings, eq(equipmentChecks.bookingId, bookings.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(equipmentChecks.needsAttention, true))
    .orderBy(desc(equipmentChecks.recordedAt))
}

export interface UnbracketedSession {
  bookingId: string
  startTime: Date
  endTime: Date
  providerName: string
  serviceName: string
  hasAfter: boolean
}

/**
 * Sessions nobody can account for: the laser was used and no arrival photograph was taken.
 *
 * This is the exception that cannot be repaired. Once the next person has used the machine, a
 * photo taken now shows a state that provider did not leave it in — so this list is a record, not
 * a to-do. Oldest first, because age is what matters in a list of things nobody dealt with.
 *
 * Bounded to a window rather than all of history: every appointment before this feature shipped
 * is unbracketed, and a page opening with a hundred unfixable rows is a page nobody opens twice.
 */
export async function getUnbracketedSessions(sinceDays = 30): Promise<UnbracketedSession[]> {
  // Never earlier than the day this was asked for. A session from before then is unbracketed
  // because nobody had been asked, not because anybody skipped anything, and an exceptions list
  // full of things nobody could have affected is one people stop reading.
  const window = new Date(Date.now() - sinceDays * 24 * 60 * 60_000)
  const since = window > EQUIPMENT_LOG_STARTED_AT ? window : EQUIPMENT_LOG_STARTED_AT

  return db
    .select({
      bookingId: bookings.id,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      serviceName: services.name,
      hasAfter: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'after'
      )`,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        sql`${bookings.status} in ('upcoming', 'completed')`,
        lt(bookings.endTime, new Date()),
        gte(bookings.startTime, since),
        sql`not exists (
          select 1 from ${equipmentChecks}
          where ${equipmentChecks}.booking_id = ${bookings}.id
            and ${equipmentChecks}.kind = 'before'
        )`,
      ),
    )
    .orderBy(asc(bookings.startTime))
}

export interface RecentCheck extends EquipmentPhoto {
  bookingId: string
  startTime: Date
}

/** The log itself, newest first — for "show me the laser last Tuesday". */
export async function getRecentChecks(limit = 40): Promise<RecentCheck[]> {
  return db
    .select({
      id: equipmentChecks.id,
      bookingId: equipmentChecks.bookingId,
      kind: equipmentChecks.kind,
      recordedAt: equipmentChecks.recordedAt,
      storageKey: equipmentChecks.storageKey,
      note: equipmentChecks.note,
      needsAttention: equipmentChecks.needsAttention,
      photoDeletedAt: equipmentChecks.photoDeletedAt,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      startTime: bookings.startTime,
    })
    .from(equipmentChecks)
    .innerJoin(providers, eq(equipmentChecks.providerId, providers.id))
    .innerJoin(bookings, eq(equipmentChecks.bookingId, bookings.id))
    .orderBy(desc(equipmentChecks.recordedAt))
    .limit(limit)
}
