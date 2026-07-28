import 'server-only'

import { and, asc, eq, gte, lt, ne } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providerServices, providers, roomBookings, services } from '@/lib/db/schema'

// What the medical director sees.
//
// His duty is over PEOPLE, not appointments: he is the physician whose license the treatments
// are performed under, so the questions are "who am I covering", "are they credentialed", and
// "what procedures are they performing". A calendar alone answers none of those.
//
// Scoped to providers on Melanite's medical director. Someone who brought their own physician
// is not his responsibility, and showing them would blur exactly the line that matters.
//
// No money. Not because it is secret, but because it is not his job — the split, the payouts
// and the ledger belong to the people running the business.

/** How far ahead the schedule looks. Two weeks is what "what should I expect" means in
 *  practice; a full quarter of laser appointments is a list nobody reads to the bottom of. */
export const OVERSIGHT_DAYS = 14

export interface OverseenProvider {
  id: string
  name: string
  email: string
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  bookingEnabled: boolean
  /** What they are credentialed to perform, and at what length. The clinical scope he is
   *  actually signing off on. */
  services: { name: string; durationMins: number }[]
}

export interface ScheduledItem {
  id: string
  kind: 'appointment' | 'room'
  startTime: Date
  endTime: Date
  providerName: string
  /** Null for a room rental — nobody is being treated, the room is simply taken. */
  clientName: string | null
  serviceName: string | null
  treatmentArea: string | null
  status: string
}

/** The providers practising under Melanite's medical director, with their clinical scope. */
export async function getOverseenProviders(): Promise<OverseenProvider[]> {
  const rows = await db
    .select({
      id: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      email: providers.email,
      licenseNumber: providers.licenseNumber,
      licenseState: providers.licenseState,
      licenseExpiry: providers.licenseExpiry,
      bookingEnabled: providers.bookingEnabled,
    })
    .from(providers)
    .where(
      and(
        eq(providers.medicalDirectorType, 'melanite'),
        eq(providers.status, 'active'),
        ne(providers.role, 'medical_director'),
      ),
    )
    .orderBy(asc(providers.lastName), asc(providers.firstName))

  if (rows.length === 0) return []

  // One query for every provider's services rather than one per provider. v1's calendar did the
  // per-row thing and it is the reason that endpoint got slow.
  const scope = await db
    .select({
      providerId: providerServices.providerId,
      name: services.name,
      durationMins: providerServices.durationMins,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(providerServices.isActive, true))
    .orderBy(asc(services.name))

  const byProvider = new Map<string, { name: string; durationMins: number }[]>()
  for (const row of scope) {
    const list = byProvider.get(row.providerId) ?? []
    list.push({ name: row.name, durationMins: row.durationMins })
    byProvider.set(row.providerId, list)
  }

  return rows.map((row) => ({
    id: row.id,
    name: `${row.firstName} ${row.lastName}`,
    email: row.email,
    licenseNumber: row.licenseNumber,
    licenseState: row.licenseState,
    licenseExpiry: row.licenseExpiry,
    bookingEnabled: row.bookingEnabled,
    services: byProvider.get(row.id) ?? [],
  }))
}

/**
 * Appointments and room rentals ahead, on one timeline.
 *
 * Forward-looking only. This is a "what should I expect" view, not a record — history is a
 * different question and belongs on a different screen if it is ever needed.
 *
 * Cancelled bookings are excluded here, unlike on the admin calendar. An admin asks "did that
 * get cancelled?"; the medical director is asking what is going to happen, and a struck-through
 * row is noise in that list.
 */
export async function getUpcomingSchedule(days = OVERSIGHT_DAYS): Promise<ScheduledItem[]> {
  const now = new Date()
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

  const [appointments, rentals] = await Promise.all([
    db
      .select({
        id: bookings.id,
        startTime: bookings.startTime,
        endTime: bookings.endTime,
        clientName: bookings.clientName,
        treatmentArea: bookings.treatmentArea,
        status: bookings.status,
        firstName: providers.firstName,
        lastName: providers.lastName,
        serviceName: services.name,
      })
      .from(bookings)
      .innerJoin(providers, eq(bookings.providerId, providers.id))
      .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
      .innerJoin(services, eq(providerServices.serviceId, services.id))
      .where(
        and(
          gte(bookings.startTime, now),
          lt(bookings.startTime, until),
          ne(bookings.status, 'cancelled'),
        ),
      )
      .orderBy(asc(bookings.startTime)),

    db
      .select({
        id: roomBookings.id,
        startTime: roomBookings.startAt,
        endTime: roomBookings.endAt,
        slotType: roomBookings.slotType,
        status: roomBookings.status,
        firstName: providers.firstName,
        lastName: providers.lastName,
      })
      .from(roomBookings)
      .innerJoin(providers, eq(roomBookings.providerId, providers.id))
      .where(
        and(
          gte(roomBookings.startAt, now),
          lt(roomBookings.startAt, until),
          ne(roomBookings.status, 'cancelled'),
        ),
      )
      .orderBy(asc(roomBookings.startAt)),
  ])

  const items: ScheduledItem[] = [
    ...appointments.map((a) => ({
      id: a.id,
      kind: 'appointment' as const,
      startTime: a.startTime,
      endTime: a.endTime,
      providerName: `${a.firstName} ${a.lastName}`,
      clientName: a.clientName,
      serviceName: a.serviceName,
      treatmentArea: a.treatmentArea,
      status: a.status,
    })),
    ...rentals.map((r) => ({
      id: r.id,
      kind: 'room' as const,
      startTime: r.startTime,
      endTime: r.endTime,
      providerName: `${r.firstName} ${r.lastName}`,
      clientName: null,
      serviceName: null,
      treatmentArea: r.slotType,
      status: r.status,
    })),
  ]

  // Merged and re-sorted, so the two kinds interleave by time rather than sitting in separate
  // lists that have to be read together to answer "what is happening on Thursday".
  return items.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
}
