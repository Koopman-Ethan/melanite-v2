import 'server-only'

import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, packageRedemptions, providerServices, services } from '@/lib/db/schema'

// v1's GET /appointments loaded every booking for the provider and filtered them in
// application code, and returned raw booking rows with no service name — so the page had to
// fetch /provider-services separately and join in the browser. Here it is one query with the
// filters in SQL and the service name already attached.

export type AppointmentStatus = (typeof bookings.status.enumValues)[number]

export interface AppointmentFilters {
  status?: AppointmentStatus
  /** `YYYY-MM`, interpreted in America/Denver — the business timezone, not UTC. */
  month?: string
  providerServiceId?: string
}

export interface Appointment {
  id: string
  clientName: string
  clientPhone: string | null
  clientEmail: string | null
  clientId: string | null
  treatmentArea: string | null
  notes: string | null
  price: string
  originalPrice: string
  discountPct: string
  paymentSource: (typeof bookings.paymentSource.enumValues)[number]
  durationMins: number
  startTime: Date
  endTime: Date
  status: AppointmentStatus
  serviceName: string
  serviceColor: string | null
  providerServiceId: string
  /** True when a live (non-voided) redemption points at this booking.
   *
   *  This is what decides which cancel action is legal. v1 could not tell from the booking
   *  alone — a redemption came back as an ordinary $0 booking — so its cancel endpoint had to
   *  look for a redemption row and refuse with USE_PACKAGE_CANCEL. Cancelling the wrong way
   *  would have destroyed a session the client had already paid for. */
  isPackageRedemption: boolean
}

/** Month boundaries computed in America/Denver. A booking at 7pm Mountain on the 31st is
 *  still that month; in UTC it would have rolled over. */
function monthFilter(month: string): SQL {
  return sql`(${bookings.startTime} AT TIME ZONE 'America/Denver') >= ${`${month}-01`}::timestamp
         AND (${bookings.startTime} AT TIME ZONE 'America/Denver') < (${`${month}-01`}::timestamp + interval '1 month')`
}

export async function getAppointments(
  providerId: string,
  filters: AppointmentFilters = {},
): Promise<Appointment[]> {
  const where: SQL[] = [eq(bookings.providerId, providerId)]
  if (filters.status) where.push(eq(bookings.status, filters.status))
  if (filters.providerServiceId) {
    where.push(eq(bookings.providerServiceId, filters.providerServiceId))
  }
  if (filters.month) where.push(monthFilter(filters.month))

  return db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      clientPhone: bookings.clientPhone,
      clientEmail: bookings.clientEmail,
      clientId: bookings.clientId,
      treatmentArea: bookings.treatmentArea,
      notes: bookings.notes,
      price: bookings.price,
      originalPrice: bookings.originalPrice,
      discountPct: bookings.discountPct,
      paymentSource: bookings.paymentSource,
      durationMins: bookings.durationMins,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      status: bookings.status,
      serviceName: services.name,
      serviceColor: services.colorHex,
      providerServiceId: bookings.providerServiceId,
      isPackageRedemption: sql<boolean>`exists (
        select 1 from ${packageRedemptions}
        where ${packageRedemptions.bookingId} = ${bookings.id}
          and ${packageRedemptions.voidedAt} is null
      )`,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(and(...where))
    .orderBy(desc(bookings.startTime))
}

/** One booking, scoped to its owner. Ownership is part of the query rather than a check
 *  afterwards, so there is no path that reads someone else's booking first and decides later. */
export async function getAppointment(
  providerId: string,
  bookingId: string,
): Promise<Appointment | null> {
  const [row] = await getAppointmentsById(providerId, bookingId)
  return row ?? null
}

async function getAppointmentsById(providerId: string, bookingId: string) {
  return db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      clientPhone: bookings.clientPhone,
      clientEmail: bookings.clientEmail,
      clientId: bookings.clientId,
      treatmentArea: bookings.treatmentArea,
      notes: bookings.notes,
      price: bookings.price,
      originalPrice: bookings.originalPrice,
      discountPct: bookings.discountPct,
      paymentSource: bookings.paymentSource,
      durationMins: bookings.durationMins,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      status: bookings.status,
      serviceName: services.name,
      serviceColor: services.colorHex,
      providerServiceId: bookings.providerServiceId,
      isPackageRedemption: sql<boolean>`exists (
        select 1 from ${packageRedemptions}
        where ${packageRedemptions.bookingId} = ${bookings.id}
          and ${packageRedemptions.voidedAt} is null
      )`,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1)
}

/** Services this provider offers, for the filter dropdown. */
export async function getProviderServiceOptions(providerId: string) {
  return db
    .select({
      id: providerServices.id,
      name: services.name,
      isActive: providerServices.isActive,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(providerServices.providerId, providerId))
    .orderBy(asc(services.name))
}

/** Months that actually have bookings, so the filter offers only real options rather than a
 *  rolling window of mostly-empty months. */
export async function getBookedMonths(providerId: string): Promise<string[]> {
  const rows = await db
    .select({
      month: sql<string>`to_char(${bookings.startTime} AT TIME ZONE 'America/Denver', 'YYYY-MM')`,
    })
    .from(bookings)
    .where(eq(bookings.providerId, providerId))
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`))

  return rows.map((r) => r.month)
}

export interface AppointmentCounts {
  upcoming: number
  completed: number
  cancelled: number
  no_show: number
  total: number
}

export async function getAppointmentCounts(providerId: string): Promise<AppointmentCounts> {
  const [row] = await db
    .select({
      upcoming: sql<number>`count(*) filter (where ${bookings.status} = 'upcoming')::int`,
      completed: sql<number>`count(*) filter (where ${bookings.status} = 'completed')::int`,
      cancelled: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`,
      no_show: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(bookings)
    .where(eq(bookings.providerId, providerId))

  return row
}

export interface NextAppointment {
  id: string
  clientName: string
  startTime: Date
  serviceName: string
}

/** Next upcoming appointment, for the dashboard. Deliberately a narrower shape than
 *  `Appointment` — the dashboard needs four fields, not the whole row. */
export async function getNextAppointment(providerId: string): Promise<NextAppointment | null> {
  const [row] = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      startTime: bookings.startTime,
      serviceName: services.name,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(bookings.providerId, providerId),
        eq(bookings.status, 'upcoming'),
        gte(bookings.startTime, new Date()),
      ),
    )
    .orderBy(asc(bookings.startTime))
    .limit(1)

  return row ?? null
}
