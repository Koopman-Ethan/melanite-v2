import 'server-only'

import { and, asc, eq, gte, lt, ne, sql } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import { splitClientPayment, toCents } from '@/lib/money'
import { PROVIDER_ALREADY_HOLDS } from '@/lib/payments/direction'
import {
  bookings,
  endOfUseChecklists,
  platformSettings,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'

import { addDays, BOOKING_HAS_PURCHASE } from './admin-calendar'
import { denverInstant } from './availability'

// One evening's appointments, for the digest Keoni gets after the suite closes.
//
// Deliberately NOT in `revenue.ts`. Everything there groups `ledger_entries` to answer "how
// much has Melanite made"; this is a per-booking operational read of a single Denver day, and
// it needs `denverInstant`/`addDays`, which that module has no other reason to import.
//
// The question this answers is narrower than it looks: not "what was charged" but "who is
// holding money that belongs to Melanite". A Groupon voucher and a card payment are the same
// amount on the same service and mean completely different things afterwards.

export interface DigestAppointment {
  bookingId: string
  startTime: Date
  clientName: string
  serviceName: string
  providerId: string
  providerName: string
  /** Melanite's own appointment. Shown, but never counted as something to collect. */
  isHouse: boolean
  status: string
  price: string
  paymentSource: string
  /** How the booking said it would be paid. */
  externalMethod: string | null
  /** Whether a purchase ledger row exists. There is no "reimbursed" column in this schema —
   *  recording the payment IS the act of saying collected. */
  reconciled: boolean
  /** The method on the purchase row, when there is one: how it was ACTUALLY paid, which can
   *  differ from what the booking predicted. Null until somebody records it. */
  recordedMethod: string | null
  /** Rent Melanite kept for this session, in cents. Nets off a refund, so a no-show that was
   *  given back reads as zero rather than as income. Null when no rental fee was ever charged. */
  rentalCents: number | null
  /** A pack session covered it, so nothing was charged and nothing is missing. */
  paidFromPack: boolean
  /** A rental booking that was never billed and no pack paid for.
   *
   *  This is the crash window from `app/app/book/actions.ts` showing up where somebody will
   *  actually see it. Zero rent on a session that used the laser is the one thing in this email
   *  that means a bug rather than a quiet day.
   */
  unbilled: boolean
  /** How the suite was signed off after this session, or null if nobody did.
   *
   *  A left join rather than a correlated subquery: `end_of_use_checklists` is unique on
   *  `booking_id`, so unlike the ledger it cannot duplicate the appointment. */
  closeout: {
    itemsDone: number
    itemCount: number
    deviceIssue: boolean
    /** The raw keys, so the caller can name what was skipped without a second query. */
    completedItems: string[]
  } | null
}

/** Folds the three left-joined close-out columns into one object, so callers have a single thing
 *  to check rather than three that can disagree. `itemCount` is NOT NULL on the table, so a
 *  non-null value is what proves a row exists. */
function asDigestAppointment(row: RawDigestAppointment): DigestAppointment {
  const { closeoutItems, closeoutItemCount, closeoutDeviceIssue, hasRentalRow, ...rest } = row
  return {
    ...rest,
    rentalCents: row.rentalCents === null ? null : Number(row.rentalCents),
    // Decided on whether a ledger row EXISTS, not on whether it sums to something. A refunded
    // no-show nets to zero and was billed perfectly correctly; treating that as unbilled would
    // put a false alarm in the email every time somebody did not turn up.
    unbilled:
      row.paymentSource === 'rental' && !row.isHouse && !row.paidFromPack && !hasRentalRow,
    // A rental booking has no client — see `lib/booking-labels.ts`.
    clientName: clientLabel(row.clientName),
    closeout:
      closeoutItemCount === null
        ? null
        : {
            itemsDone: closeoutItems?.length ?? 0,
            itemCount: closeoutItemCount,
            deviceIssue: closeoutDeviceIssue ?? false,
            completedItems: closeoutItems ?? [],
          },
  }
}

type RawDigestAppointment = Omit<
  DigestAppointment,
  'closeout' | 'clientName' | 'unbilled' | 'rentalCents'
> & {
  rentalCents: number | null
  /** Whether any rental_fee row exists at all, refund included. */
  hasRentalRow: boolean
  /** Null on a rental booking. Resolved by `asDigestAppointment`, so the digest template never
   *  has to decide what to print for a client Melanite deliberately does not know about. */
  clientName: string | null
  closeoutItems: string[] | null
  closeoutItemCount: number | null
  closeoutDeviceIssue: boolean | null
}

export interface DigestDay {
  /** YYYY-MM-DD, Denver. */
  day: string
  appointments: DigestAppointment[]
  /** Counted, not listed — nobody owes anything for a treatment that did not happen, but a
   *  quiet day and a broken query look identical unless the cancellations are acknowledged. */
  cancelled: number
  providerSharePct: number
}

/**
 * Melanite's half of one appointment, in CENTS, when the provider is still holding it.
 *
 * Zero for everything else, and the order of these guards matters:
 *
 *   house         Melanite's own client. Invoicing this is invoicing yourself.
 *   reconciled    somebody already recorded the payment, so it is settled.
 *   not external  a card, a package or a prepaid balance settles itself.
 *   cherry        pays MELANITE, which then owes the PROVIDER — the debt runs the other way,
 *                 and it falls out for free by not being in PROVIDER_ALREADY_HOLDS.
 *
 * Pure, so the rule is testable without a database. The arithmetic goes through
 * `splitClientPayment` rather than multiplying in SQL: `lib/money.ts` exists because three
 * call sites disagreed by a cent, and Melanite's share is `1 - providerSharePct`, not
 * `providerSharePct`.
 */
export function toCollectCents(
  row: Pick<
    DigestAppointment,
    'isHouse' | 'reconciled' | 'paymentSource' | 'externalMethod' | 'price'
  >,
  providerSharePct: number,
): number {
  if (row.isHouse) return 0
  if (row.reconciled) return 0
  if (row.paymentSource !== 'external') return 0
  if (!PROVIDER_ALREADY_HOLDS.has(row.externalMethod ?? '')) return 0

  return splitClientPayment({
    grossCents: toCents(row.price),
    tipCents: 0,
    providerSharePct,
  }).melaniteCutCents
}

/** Every appointment on one Denver day, with enough to say who owes what. */
export async function getDigestDay(day: string): Promise<DigestDay> {
  // Midnight to midnight rather than the laser's opening hours: a booking entered outside them
  // still happened, and an email that silently drops it is worse than one that looks odd.
  const from = denverInstant(day, '00:00')
  const to = denverInstant(addDays(day, 1), '00:00')

  // Keyed on start time alone, matching the calendar: a booking belongs to the day it starts.
  const within = and(gte(bookings.startTime, from), lt(bookings.startTime, to))

  const [rows, [cancelled], [settings]] = await Promise.all([
    db
      .select({
        bookingId: bookings.id,
        startTime: bookings.startTime,
        clientName: bookings.clientName,
        serviceName: services.name,
        providerId: providers.id,
        providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
        isHouse: sql<boolean>`${providers.revenueModel} = 'house'`,
        status: bookings.status,
        price: bookings.price,
        paymentSource: bookings.paymentSource,
        externalMethod: bookings.externalMethod,
        reconciled: BOOKING_HAS_PURCHASE,
        // A correlated subquery rather than a join, so a booking with two ledger rows — a
        // purchase and a later refund — cannot duplicate the appointment in the email.
        closeoutItems: endOfUseChecklists.completedItems,
        closeoutItemCount: endOfUseChecklists.itemCount,
        closeoutDeviceIssue: endOfUseChecklists.deviceIssue,
        // Summed rather than read off one row, so a purchase and its later refund net to what
        // Melanite actually kept for the day.
        rentalCents: sql<number | null>`(
          select round(sum(l.gross_amount) * 100)::int from ledger_entries l
          where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
            and l.source = 'rental_fee'
        )`,
        hasRentalRow: sql<boolean>`exists (
          select 1 from ledger_entries l
          where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
            and l.source = 'rental_fee'
        )`,
        paidFromPack: sql<boolean>`exists (
          select 1 from provider_pack_redemptions r
          where r.booking_id = ${bookings.id} and r.voided_at is null
        )`,
        recordedMethod: sql<string | null>`(
          select l.payment_method from ledger_entries l
          where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
            and l.entry_type = 'purchase'
          order by l.created_at asc
          limit 1
        )`,
      })
      .from(bookings)
      .innerJoin(providers, eq(bookings.providerId, providers.id))
      .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
      .innerJoin(services, eq(providerServices.serviceId, services.id))
      .leftJoin(endOfUseChecklists, eq(endOfUseChecklists.bookingId, bookings.id))
      .where(and(within, ne(bookings.status, 'cancelled')))
      .orderBy(asc(bookings.startTime)),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(and(within, eq(bookings.status, 'cancelled'))),

    db
      .select({ pct: platformSettings.providerSharePct })
      .from(platformSettings)
      .where(eq(platformSettings.id, 1))
      .limit(1),
  ])

  return {
    day,
    appointments: rows.map(asDigestAppointment),
    cancelled: cancelled?.n ?? 0,
    providerSharePct: Number(settings?.pct ?? 0.5),
  }
}
