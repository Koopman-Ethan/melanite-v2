import 'server-only'

import { and, asc, desc, eq, gte, sql, type SQL } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import {
  bookings,
  checkoutLinks,
  endOfUseChecklists,
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
  /** Rent Melanite kept for this session, in cents, netting off a refund. Null when none was
   *  charged — which for a rental booking means a credited session covered it, or it is
   *  Melanite's own appointment.
   *
   *  The ONLY money on a rental booking. `price` is the client's, which Melanite no longer
   *  knows and forces to zero, so a list showing `price` shows $0.00 for a session the
   *  provider was charged $60 for. */
  rentalCents: number | null
  /** A credited session paid for it, so nothing was charged and nothing is missing. */
  paidFromCredit: boolean
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
  /** How this session was signed off, or null if nobody has.
   *
   *  Assembled from three columns by `asAppointment` so callers get one thing to check rather
   *  than three that can disagree. `itemCount` is the row's OWN denominator, not today's — a
   *  close-out signed against a 25-item list keeps reading as complete after the list grows. */
  closeout: { itemsDone: number; itemCount: number; deviceIssue: boolean } | null
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

  const rows = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      rentalCents: sql<number | null>`(
        select round(sum(l.gross_amount) * 100)::int from ledger_entries l
        where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
          and l.source = 'rental_fee'
      )`,
      paidFromCredit: sql<boolean>`exists (
        select 1 from provider_pack_redemptions r
        where r.booking_id = ${bookings.id} and r.voided_at is null
      )`,
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
      checkoutToken: checkoutLinks.token,
      checkoutStatus: checkoutLinks.status,
      checkoutExpiresAt: checkoutLinks.expiresAt,
      closeoutItems: endOfUseChecklists.completedItems,
      closeoutItemCount: endOfUseChecklists.itemCount,
      closeoutDeviceIssue: endOfUseChecklists.deviceIssue,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    // Left, not inner: an externally-paid or comped booking never had a link, and inner-joining
    // would drop those rows from the provider's own appointment list entirely.
    .leftJoin(checkoutLinks, eq(checkoutLinks.bookingId, bookings.id))
    // Left, and safe to join rather than subquery: `end_of_use_checklists` is unique on
    // `booking_id`, so this can add at most one row and cannot duplicate an appointment. Going
    // through Drizzle's column mapping also keeps these arriving as real types, which the
    // arriving as real types rather than strings, which the note on `asAppointment` explains.
    .leftJoin(endOfUseChecklists, eq(endOfUseChecklists.bookingId, bookings.id))
    .where(and(...where))
    .orderBy(desc(bookings.startTime))

  return rows.map(asAppointment)
}

/** Folds the left-joined close-out columns into one object.
 *
 *  It used to convert `nextLaserUseAt` as well — a raw `sql` fragment arrives as a string rather
 *  than a Date, and treating it as one took down the whole appointments list for any booking that
 *  had another after it. That column went with the before/after photographs; the lesson did not,
 *  which is why the close-out fields below come through Drizzle's own mapping instead. */
function asAppointment(row: RawAppointment): Appointment {
  const { closeoutItems, closeoutItemCount, closeoutDeviceIssue, ...rest } = row
  return {
    ...rest,
    // A rental booking has no client — Melanite never asked for one. See `lib/booking-labels.ts`.
    clientName: clientLabel(row.clientName),
    // The left join produces nulls across all three when no close-out exists. `itemCount` is the
    // one that decides: it is NOT NULL on the table, so a non-null value means there is a row.
    closeout:
      closeoutItemCount === null
        ? null
        : {
            itemsDone: closeoutItems?.length ?? 0,
            itemCount: closeoutItemCount,
            deviceIssue: closeoutDeviceIssue ?? false,
          },
  }
}

type RawAppointment = Omit<Appointment, 'closeout' | 'clientName'> & {
  /** Null on a rental booking, where there is no client to name. `asAppointment` resolves it;
   *  `Appointment` stays a string so no view has to decide what to print for an absent one. */
  clientName: string | null
  closeoutItems: string[] | null
  closeoutItemCount: number | null
  closeoutDeviceIssue: boolean | null
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
      rentalCents: sql<number | null>`(
        select round(sum(l.gross_amount) * 100)::int from ledger_entries l
        where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
          and l.source = 'rental_fee'
      )`,
      paidFromCredit: sql<boolean>`exists (
        select 1 from provider_pack_redemptions r
        where r.booking_id = ${bookings.id} and r.voided_at is null
      )`,
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
      checkoutToken: checkoutLinks.token,
      checkoutStatus: checkoutLinks.status,
      checkoutExpiresAt: checkoutLinks.expiresAt,
      closeoutItems: endOfUseChecklists.completedItems,
      closeoutItemCount: endOfUseChecklists.itemCount,
      closeoutDeviceIssue: endOfUseChecklists.deviceIssue,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .leftJoin(checkoutLinks, eq(checkoutLinks.bookingId, bookings.id))
    // Left, and safe to join rather than subquery: `end_of_use_checklists` is unique on
    // `booking_id`, so this can add at most one row and cannot duplicate an appointment. Going
    // through Drizzle's column mapping also keeps these arriving as real types, which the
    // arriving as real types rather than strings, which the note on `asAppointment` explains.
    .leftJoin(endOfUseChecklists, eq(endOfUseChecklists.bookingId, bookings.id))
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

  return row ? { ...row, clientName: clientLabel(row.clientName) } : null
}

export interface RentalBookingSummary {
  serviceName: string
  startTime: Date
  /** What was taken off the card, in cents. Null when nothing was — a pack session covered it,
   *  or this is Melanite's own appointment. */
  chargedCents: number | null
  /** "Session 4 of 6", when a pack paid for it. */
  packSession: { index: number; total: number } | null
}

/** What to tell a provider who has just reserved the laser.
 *
 *  Replaces the payment-link banner, which had nothing to say under the rental model: there is no
 *  client, no link and nothing to send. What a provider needs to see is that the slot is theirs
 *  and what it cost them — money left their card a second ago and the confirmation should say so
 *  rather than leaving them to find it on a statement.
 *
 *  Scoped to the provider, for the same reason the link query was.
 */
export async function getRentalBookingSummary(
  bookingId: string,
  providerId: string,
): Promise<RentalBookingSummary | null> {
  const [row] = await db
    .select({
      serviceName: services.name,
      startTime: bookings.startTime,
      charged: sql<string | null>`(
        SELECT le.gross_amount FROM ledger_entries le
         WHERE le.subject_type = 'booking' AND le.subject_id = ${bookings.id}
           AND le.source = 'rental_fee' AND le.entry_type = 'purchase'
         LIMIT 1
      )`,
      packIndex: sql<number | null>`(
        SELECT r.session_index FROM provider_pack_redemptions r
         WHERE r.booking_id = ${bookings.id} AND r.voided_at IS NULL LIMIT 1
      )`,
      packTotal: sql<number | null>`(
        SELECT p.sessions_total FROM provider_pack_redemptions r
          JOIN provider_packs p ON p.id = r.provider_pack_id
         WHERE r.booking_id = ${bookings.id} AND r.voided_at IS NULL LIMIT 1
      )`,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1)

  if (!row) return null

  return {
    serviceName: row.serviceName,
    startTime: row.startTime,
    chargedCents: row.charged === null ? null : Math.round(Number(row.charged) * 100),
    packSession:
      row.packIndex === null || row.packTotal === null
        ? null
        : { index: Number(row.packIndex), total: Number(row.packTotal) },
  }
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
