import 'server-only'

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import {
  bookings,
  checkoutLinks,
  ledgerEntries,
  platformSettings,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'

// Admin tools — the escape hatch.
//
// Reality does not route entirely through this app: clients finance with Cherry, redeem
// Groupon vouchers, hand over cash, or pay Keoni for several months of medical direction at
// once. Without somewhere to record those, the money either goes missing from the system or
// gets faked into a shape that lies about how it arrived.
//
// Every tool here is narrow and validated rather than a generic row editor. A free-form editor
// on the ledger is how a system quietly stops reconciling.

export interface UnpaidBooking {
  id: string
  clientName: string
  providerName: string
  serviceName: string
  startTime: Date
  price: string
  status: string
  paymentSource: string
  externalMethod: string | null
}

/** Appointments with no money recorded against them.
 *
 *  Useful beyond the tool itself: this is the reconciliation gap made visible. A completed
 *  appointment with no ledger entry is either unpaid, or paid by a route nobody recorded —
 *  and in v1 there was no way to tell those apart or even to notice.
 */
export async function getUnpaidBookings(limit = 50): Promise<UnpaidBooking[]> {
  const rows = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      serviceName: services.name,
      startTime: bookings.startTime,
      price: bookings.price,
      status: bookings.status,
      paymentSource: bookings.paymentSource,
      /** What the provider said the client paid with, when they paid outside the app. Carried
       *  so the reconciliation form can pre-select it — Keoni confirms a figure rather than
       *  re-deriving one from memory. */
      externalMethod: bookings.externalMethod,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        // A package redemption is already paid for — the money settled at purchase — and a
        // comp was never going to be paid. Neither belongs on an "unpaid" list.
        //
        // External payments DO belong on it, and this filter excluded them. Without that, a
        // provider marking a booking as Groupon put it somewhere Keoni would never look — the
        // exact hole this whole feature exists to close, reproduced one query later.
        sql`${bookings.paymentSource} in ('checkout_link', 'external')`,
        sql`${bookings.status} <> 'cancelled'`,
        sql`not exists (
          select 1 from ${ledgerEntries}
          where ${ledgerEntries.subjectType} = 'booking'
            and ${ledgerEntries.subjectId} = ${bookings.id}
        )`,
      ),
    )
    .orderBy(desc(bookings.startTime))
    .limit(limit)

  // A rental booking is filtered out above and cannot reach here, but the column is nullable
  // now and this list is read by somebody chasing money — a blank where a name goes reads as
  // missing data rather than as a booking that never had one.
  return rows.map((r) => ({ ...r, clientName: clientLabel(r.clientName) }))
}

export interface CherryHandoff {
  id: string
  /** Which financing route this is. Only appointments now — packages were removed on
   *  14 October — but the field stays rather than being dropped, because the shape is what the
   *  tools page renders and a second route through Cherry is more likely than not. */
  kind: 'booking'
  clientName: string | null
  clientEmail: string | null
  providerName: string
  /** The package name, or the service and when the appointment is. */
  what: string
  price: string
  startedAt: Date
  waitingDays: number
}

/** Everybody who left for Cherry and has not been settled since.
 *
 *  This is the one payment route with no webhook and no callback. The client finishes on
 *  Cherry's site, Cherry pays Keoni in full, and Keoni owes the provider their half — a chain
 *  that lives entirely outside the app. Before this, the only signal was the client telling
 *  their provider, and the link sat at `pending` looking exactly like one nobody had opened.
 *
 *  Recorded intent, not payment. A row here means "somebody went to apply", which is a reason
 *  to go and look at Cherry, not a figure to put in the ledger. It leaves the list the moment
 *  the thing is paid for by any route — including Keoni recording it by hand — so it cannot
 *  linger after it has been dealt with.
 *
 *  APPOINTMENTS ONLY since 14 October. It used to merge package links in as well, and the
 *  merge is gone with the feature — but `package_checkout_links` and its historical
 *  `cherry_started_at` rows are untouched, because a client who financed a package through
 *  Cherry really did, and the ledger still points at it.
 *
 *  Oldest first: the one waiting longest is the one to chase.
 */
export async function getCherryHandoffs(limit = 25): Promise<CherryHandoff[]> {
  const appointments = await db
      .select({
        id: checkoutLinks.id,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
        what: sql<string>`${services.name} || ', ' || to_char(${bookings.startTime} at time zone 'America/Denver', 'FMMon FMDD')`,
        price: bookings.price,
        startedAt: sql<Date>`${checkoutLinks.cherryStartedAt}`,
        waitingDays: sql<number>`floor(extract(epoch from now() - ${checkoutLinks.cherryStartedAt}) / 86400)::int`,
      })
      .from(checkoutLinks)
      .innerJoin(bookings, eq(checkoutLinks.bookingId, bookings.id))
      .innerJoin(providers, eq(bookings.providerId, providers.id))
      .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
      .innerJoin(services, eq(providerServices.serviceId, services.id))
      .where(
        and(
          isNotNull(checkoutLinks.cherryStartedAt),
          eq(checkoutLinks.status, 'pending'),
          // A cancelled appointment is not something to chase somebody about, whatever they
          // started on Cherry.
          sql`${bookings.status} <> 'cancelled'`,
          // Paid by some other route in the meantime — it is settled, whoever settled it.
          sql`not exists (
            select 1 from ${ledgerEntries}
            where ${ledgerEntries.subjectType} = 'booking'
              and ${ledgerEntries.subjectId} = ${bookings.id}
          )`,
        ),
      )
      .orderBy(asc(checkoutLinks.cherryStartedAt))
      .limit(limit)

  return appointments.map((b) => ({ ...b, kind: 'booking' as const }))
}

export interface ManualEntry {
  id: string
  createdAt: Date
  source: string
  paymentMethod: string
  grossAmount: string
  melaniteCut: string
  providerPayout: string
  externalReference: string | null
  note: string | null
  providerName: string | null
  recordedByName: string | null
}

/** Everything entered by hand.
 *
 *  `recordedBy` is null for machine-generated rows, which is exactly what makes this
 *  answerable — a hand-entered figure should always be attributable to a person. */
export async function getManualEntries(limit = 40): Promise<ManualEntry[]> {
  const recorder = sql`(select ${providers.firstName} || ' ' || ${providers.lastName}
                        from ${providers} where ${providers.id} = ${ledgerEntries.recordedBy})`

  return db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      source: ledgerEntries.source,
      paymentMethod: ledgerEntries.paymentMethod,
      grossAmount: ledgerEntries.grossAmount,
      melaniteCut: ledgerEntries.melaniteCut,
      providerPayout: ledgerEntries.providerPayout,
      externalReference: ledgerEntries.externalReference,
      note: ledgerEntries.note,
      providerName: sql<
        string | null
      >`(select p2.first_name || ' ' || p2.last_name from providers p2 where p2.id = ${ledgerEntries.providerId})`,
      recordedByName: sql<string | null>`${recorder}`,
    })
    .from(ledgerEntries)
    .where(isNotNull(ledgerEntries.recordedBy))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)
}

export async function getActiveProviders() {
  return db
    .select({
      id: providers.id,
      name: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      email: providers.email,
      medicalDirectorStatus: providers.medicalDirectorStatus,
    })
    .from(providers)
    .where(eq(providers.status, 'active'))
    .orderBy(providers.firstName)
}

export interface ServiceOption {
  id: string
  name: string
  price: string
  durationMins: number
}

/** Every provider's active services, grouped by provider.
 *
 *  Fetched whole rather than per-provider on selection: the catalog is a few dozen rows, and
 *  a round trip on every change of the provider dropdown buys nothing but latency. */
export async function getProviderServiceMap(): Promise<Record<string, ServiceOption[]>> {
  const rows = await db
    .select({
      providerId: providerServices.providerId,
      id: providerServices.id,
      name: services.name,
      price: providerServices.price,
      durationMins: providerServices.durationMins,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(providerServices.isActive, true))
    .orderBy(services.name)

  const map: Record<string, ServiceOption[]> = {}
  for (const { providerId, ...option } of rows) {
    ;(map[providerId] ??= []).push(option)
  }
  return map
}

export async function getProviderSharePct(): Promise<number> {
  const [row] = await db
    .select({ pct: platformSettings.providerSharePct })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return Number(row?.pct ?? 0.5)
}

/** What Stripe is expected to take, so a provider charge can be grossed up to cover it.
 *
 *  Two numbers rather than one because Stripe charges both a percentage and a flat amount, and
 *  the flat part is what makes a small session disproportionately expensive to collect — 30c on
 *  a $35 chin is nearly a percent on its own.
 *
 *  Falls back to Stripe's US standard rather than to zero. Zero would silently reinstate the
 *  thing this exists to stop: Keoni absorbing the fee, with nothing to show that it happened. */
export async function getProcessingRate(): Promise<{ pct: number; fixedCents: number }> {
  const [row] = await db
    .select({
      pct: platformSettings.stripeFeePct,
      fixedCents: platformSettings.stripeFeeFixedCents,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return {
    pct: Number(row?.pct ?? 0.029),
    fixedCents: row?.fixedCents ?? 30,
  }
}

/** Bookings that already have money recorded — used to warn before double-entering. */
export async function bookingHasPayment(bookingId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'booking'),
        eq(ledgerEntries.subjectId, bookingId),
        isNull(ledgerEntries.stripeRefundId),
      ),
    )
    .limit(1)

  return Boolean(row)
}

/** Provider licenses, for the admin view.
 *
 *  Nothing surfaced this anywhere before: the license is a booking gate that fails on a date,
 *  and the only person who could see it coming was the provider — on a page they have no reason
 *  to open. Renewal goes through Melanite, so Melanite has to be able to see it.
 *
 *  Only accounts that can actually book. An inactive provider whose license lapsed is not a
 *  problem anyone needs to act on.
 */
export async function getProviderLicenses(): Promise<
  { id: string; name: string; email: string; licenseExpiry: string | null }[]
> {
  return db
    .select({
      id: providers.id,
      name: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      email: providers.email,
      licenseExpiry: providers.licenseExpiry,
    })
    .from(providers)
    .where(and(eq(providers.status, 'active'), eq(providers.bookingEnabled, true)))
    .orderBy(asc(providers.lastName))
}
