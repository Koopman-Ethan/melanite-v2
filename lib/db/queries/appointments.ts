import 'server-only'

import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  checkoutLinks,
  equipmentChecks,
  packageRedemptions,
  prepaidRedemptions,
  providerServices,
  services,
} from '@/lib/db/schema'

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
  discountType: (typeof bookings.discountType.enumValues)[number]
  discountValue: string
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
  /** Drew on a prepaid dollar balance. Decides which cancel is offered, exactly as the
   *  flag above does — cancelling one of these as an ordinary booking would keep the
   *  client's money and give them nothing. */
  isPrepaidRedemption: boolean
  /** Whether the laser was photographed around this session. Selected here rather than fetched
   *  per card, because the appointments list is the one place a provider is already looking on
   *  the day they need to do it. */
  hasBeforeCheck: boolean
  hasAfterCheck: boolean
  /** The client's payment link, so a provider can send it again.
   *
   *  It used to be shown once, in the banner immediately after booking, and was unreachable
   *  after that — no card showed it and nothing resent it. A client asking "can you send that
   *  again?" had no answer, which is most of the reason a completed appointment can sit unpaid.
   *
   *  The token is a bearer credential for that client's payment page. Safe here only because
   *  every query in this file is already scoped to the signed-in provider's own bookings. */
  checkoutToken: string | null
  checkoutStatus: (typeof checkoutLinks.status.enumValues)[number] | null
  checkoutExpiresAt: Date | null
  /** When the laser is next used after this session ends, by ANY provider. Null when nothing
   *  follows. Feeds `afterNeededGiven` — the whole point being that another provider's arrival
   *  photo brackets this session, so it is a question about the machine and not about one
   *  person's calendar.
   *
   *  A real Date, and it takes work to keep it one: this comes from a raw `sql` fragment, and
   *  those bypass Drizzle's type mapping entirely — the driver returns a timestamp STRING and
   *  the `sql<Date>` annotation is simply a lie the compiler believes. Same family as the
   *  `money()` columns coming back as strings. It is converted below. */
  nextLaserUseAt: Date | null
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
  // Assembled below and mapped through `asAppointment` — see the note on `nextLaserUseAt`.
  if (filters.status) where.push(eq(bookings.status, filters.status))
  if (filters.providerServiceId) {
    where.push(eq(bookings.providerServiceId, filters.providerServiceId))
  }
  if (filters.month) where.push(monthFilter(filters.month))

  const rows = await db
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
      discountType: bookings.discountType,
      discountValue: bookings.discountValue,
      paymentSource: bookings.paymentSource,
      durationMins: bookings.durationMins,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      status: bookings.status,
      serviceName: services.name,
      serviceColor: services.colorHex,
      providerServiceId: bookings.providerServiceId,
      // Columns spelled out, not interpolated. A `sql` fragment in a SELECT projection renders
      // `${bookings.id}` as a bare `"id"`, which the inner table claims — so this compared
      // `package_redemptions.booking_id` to `package_redemptions.id` and was false for every
      // appointment that has ever existed.
      //
      // Not a cosmetic flag: it decides which cancel the provider is offered. Always-false
      // meant a package redemption was cancelled as an ordinary booking and the client's paid
      // session was NOT returned — the exact v1 failure the comment on AppointmentActions says
      // this field exists to prevent.
      isPackageRedemption: sql<boolean>`exists (
        select 1 from ${packageRedemptions}
        where ${packageRedemptions}.booking_id = ${bookings}.id
          and ${packageRedemptions}.voided_at is null
      )`,
      isPrepaidRedemption: sql<boolean>`exists (
        select 1 from ${prepaidRedemptions}
        where ${prepaidRedemptions}.booking_id = ${bookings}.id
          and ${prepaidRedemptions}.voided_at is null
      )`,
      hasBeforeCheck: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'before'
      )`,
      hasAfterCheck: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'after'
      )`,
      nextLaserUseAt: sql<Date | null>`(
        select min(n.start_time) from bookings n
        where n.status in ('upcoming', 'completed')
          and n.id <> ${bookings}.id
          and n.start_time >= ${bookings}.end_time
      )`,
      checkoutToken: checkoutLinks.token,
      checkoutStatus: checkoutLinks.status,
      checkoutExpiresAt: checkoutLinks.expiresAt,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    // Left, not inner: an externally-paid or comped booking never had a link, and inner-joining
    // would drop those rows from the provider's own appointment list entirely.
    .leftJoin(checkoutLinks, eq(checkoutLinks.bookingId, bookings.id))
    .where(and(...where))
    .orderBy(desc(bookings.startTime))

  return rows.map(asAppointment)
}

/** Converts what the driver actually returned into what the type claims.
 *
 *  Only `nextLaserUseAt` needs it. Real columns go through Drizzle's mapping and arrive as
 *  Dates; a raw `sql` fragment does not, so this one arrives as a string and every caller that
 *  treats it as a Date throws — which took down the entire appointments list for any booking
 *  that had another one after it, meaning most of them. */
function asAppointment(row: RawAppointment): Appointment {
  return {
    ...row,
    nextLaserUseAt: row.nextLaserUseAt ? new Date(row.nextLaserUseAt) : null,
  }
}

type RawAppointment = Omit<Appointment, 'nextLaserUseAt'> & {
  nextLaserUseAt: string | Date | null
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

async function getAppointmentsById(providerId: string, bookingId: string): Promise<Appointment[]> {
  const rows = await db
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
      discountType: bookings.discountType,
      discountValue: bookings.discountValue,
      paymentSource: bookings.paymentSource,
      durationMins: bookings.durationMins,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      status: bookings.status,
      serviceName: services.name,
      serviceColor: services.colorHex,
      providerServiceId: bookings.providerServiceId,
      // Columns spelled out, not interpolated. A `sql` fragment in a SELECT projection renders
      // `${bookings.id}` as a bare `"id"`, which the inner table claims — so this compared
      // `package_redemptions.booking_id` to `package_redemptions.id` and was false for every
      // appointment that has ever existed.
      //
      // Not a cosmetic flag: it decides which cancel the provider is offered. Always-false
      // meant a package redemption was cancelled as an ordinary booking and the client's paid
      // session was NOT returned — the exact v1 failure the comment on AppointmentActions says
      // this field exists to prevent.
      isPackageRedemption: sql<boolean>`exists (
        select 1 from ${packageRedemptions}
        where ${packageRedemptions}.booking_id = ${bookings}.id
          and ${packageRedemptions}.voided_at is null
      )`,
      isPrepaidRedemption: sql<boolean>`exists (
        select 1 from ${prepaidRedemptions}
        where ${prepaidRedemptions}.booking_id = ${bookings}.id
          and ${prepaidRedemptions}.voided_at is null
      )`,
      hasBeforeCheck: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'before'
      )`,
      hasAfterCheck: sql<boolean>`exists (
        select 1 from ${equipmentChecks}
        where ${equipmentChecks}.booking_id = ${bookings}.id
          and ${equipmentChecks}.kind = 'after'
      )`,
      nextLaserUseAt: sql<Date | null>`(
        select min(n.start_time) from bookings n
        where n.status in ('upcoming', 'completed')
          and n.id <> ${bookings}.id
          and n.start_time >= ${bookings}.end_time
      )`,
      checkoutToken: checkoutLinks.token,
      checkoutStatus: checkoutLinks.status,
      checkoutExpiresAt: checkoutLinks.expiresAt,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .leftJoin(checkoutLinks, eq(checkoutLinks.bookingId, bookings.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1)

  return rows.map(asAppointment)
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

/** The payment link for a booking the provider just made, for the confirmation banner.
 *
 *  Scoped to the provider on purpose: a token in a URL parameter is a bearer credential for
 *  someone else's payment page, and this must not become a way to read one by guessing ids. */
export async function getBookingLink(bookingId: string, providerId: string) {
  const [row] = await db
    .select({
      token: checkoutLinks.token,
      status: checkoutLinks.status,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
    })
    .from(checkoutLinks)
    .innerJoin(bookings, eq(checkoutLinks.bookingId, bookings.id))
    .where(and(eq(checkoutLinks.bookingId, bookingId), eq(bookings.providerId, providerId)))
    .limit(1)

  return row ?? null
}
