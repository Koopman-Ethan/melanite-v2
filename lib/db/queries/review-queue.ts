import 'server-only'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { getProviderSharePct } from '@/lib/db/queries/admin-tools'
import { CLOSEOUT_GRACE_HOURS } from '@/lib/end-of-use'
import { sharesRevenueSql } from '@/lib/db/revenue-model'
import { tierForService } from '@/lib/rental-fees'
import { sharesRevenue } from '@/lib/revenue-model'
import { REVIEW_STARTED_AT } from '@/lib/rental/review'
import { getLiveSchedule } from '@/lib/rental/schedule'
import { db } from '@/lib/db'
import {
  bookings,
  providerServices,
  providers,
  roomBookings,
  services,
  trainingCourses,
  trainingEnrollments,
} from '@/lib/db/schema'

// Everything waiting on a human decision about money.
//
// Four situations can currently arise where the system has deliberately stopped short of
// deciding, because deciding would be wrong:
//
//   1. A room rental cancelled inside 24 hours. The block is freed either way, but whether the
//      provider gets their money back is Keoni's call.
//   2. A no-show or late-cancellation fee that failed to charge — declined card, no card, no
//      consent. The appointment status is already recorded; the money is not.
//   3. A cancelled training course with deposits already taken. They may be refundable or
//      transferable to another date, which is a conversation.
//   5. A session that DID happen, for one of the three providers whose rent is half their own
//      price. The only kind here that is not an exception: an ordinary session, queued because
//      the figure comes from a price list the payer maintains and Keoni confirms it against the
//      receipt before the card is touched. Added 14 October.
//   4. Rent held on a laser session that did not happen — cancelled, or a no-show. The provider
//      has said what happened and Keoni decides whether the fee stands. This one is the LARGEST
//      by volume, because it is every cancellation and every no-show rather than an exception:
//      added 7 October when Keoni withdrew the automatic refund, on the grounds that "sometimes
//      its the clients fault, and not the providers" and the software cannot tell which.
//
// None of these were visible anywhere. v1 surfaced only the first, through a room-rentals
// endpoint filtered on `cancellation_requested`; the other three did not exist, because it
// never charged a fee, never cancelled a course in software, and had no rental model at all.
//
// Deliberately DERIVED from the state of the things themselves rather than kept in a queue
// table. A separate work-queue store is one more thing that can disagree with reality, and an
// item that lingers after being resolved is worse than no queue at all.

export type QueueKind =
  | 'room_refund'
  | 'cancelled_course_deposit'
  | 'held_rent'
  | 'rent_to_confirm'

export interface QueueItem {
  kind: QueueKind
  id: string
  /** When the thing needing a decision happened, for oldest-first ordering. */
  since: Date
  /** Whole days waiting. Computed here rather than at render: reading the clock during a render
   *  is impure, and a server and client disagreeing about "3 days" is a hydration mismatch. */
  waitingDays: number
  amount: string
  who: string
  detail: string
  /** Extra context the resolver needs, shaped per kind. */
  meta: Record<string, string | null>
}

async function roomRefunds(): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: roomBookings.id,
      rentalDate: roomBookings.rentalDate,
      slotType: roomBookings.slotType,
      price: roomBookings.price,
      cancelledAt: roomBookings.cancelledAt,
      startAt: roomBookings.startAt,
      paymentIntentId: roomBookings.stripePaymentIntentId,
      firstName: providers.firstName,
      lastName: providers.lastName,
    })
    .from(roomBookings)
    .innerJoin(providers, eq(roomBookings.providerId, providers.id))
    .where(eq(roomBookings.status, 'cancellation_requested'))
    .orderBy(asc(roomBookings.cancelledAt))

  return rows.map((r) => {
    const hoursNotice = (r.startAt.getTime() - (r.cancelledAt?.getTime() ?? Date.now())) / 3_600_000
    return {
      kind: 'room_refund' as const,
      id: r.id,
      since: r.cancelledAt ?? r.startAt,
      waitingDays: 0,
      amount: r.price,
      who: `${r.firstName} ${r.lastName}`,
      detail: `${slotLabel(r.slotType)} on ${dateLabel(r.rentalDate)}, cancelled ${hoursNotice.toFixed(1)}h before the start`,
      meta: {
        paymentIntentId: r.paymentIntentId,
        rentalDate: r.rentalDate,
      },
    }
  })
}

/** Laser sessions that did not happen, with the provider's rent still held.
 *
 *  Derived, like everything else here: the appointment is cancelled or missed, nobody has
 *  reviewed it, and nobody has waived it.
 *
 *  IT NO LONGER REQUIRES MONEY TO HAVE MOVED, which is the 12 October fix and the reason this
 *  comment is longer than the query. Rent is swept twelve hours after a session ends, so a
 *  booking cancelled before then has had nothing charged — and the old filter, which kept only
 *  rows still "holding" something, dropped exactly those. The session vanished: no reason asked
 *  of the provider, no item here, and the sweep skips cancelled bookings by design. Melanite
 *  lost the rent and nobody saw it happen. Found one minute into testing, which is roughly how
 *  long it would have taken in production.
 *
 *  So the question became "is there a decision to make?" rather than "is money held?". A
 *  resolved item still leaves without a flag: a refund nets the ledger to zero, a returned pack
 *  session is voided, a charge stamps the review, and a waiver stamps its own column.
 */
async function heldRent(): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startTime: bookings.startTime,
      reason: bookings.outcomeReason,
      serviceName: services.name,
      firstName: providers.firstName,
      lastName: providers.lastName,
      heldCents: sql<number>`coalesce((
        select round(sum(l.gross_amount) * 100)::int
        from ledger_entries l
        where l.subject_type = 'booking' and l.subject_id = bookings.id
          and l.source = 'rental_fee'
      ), 0)`,
      heldSession: sql<boolean>`exists (
        select 1 from provider_pack_redemptions r
        where r.booking_id = bookings.id and r.voided_at is null
      )`,
      revenueModel: providers.revenueModel,
      /** What the session was worth to the client, after any discount — the booking's own
       *  price, not the provider's list price. Melanite's half of THIS is what is owed. */
      bookedPrice: bookings.price,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        // BOTH MODELS, not just rental. A session that did not happen raises the same question
        // whoever the provider is: do they owe Melanite a fee for it? Restricting this to
        // payment_source = 'rental' made Keoni's review true for five providers and false for
        // the three she grandfathered — and her instruction was explicitly "no matter how the
        // appointment gets cancelled".
        sql`(${bookings.paymentSource} = 'rental' OR ${sharesRevenueSql(providers.revenueModel)})`,
        sql`${bookings.status} IN ('cancelled', 'no_show')`,
        // Nothing from before the policy existed. See REVIEW_STARTED_AT — without it the queue
        // opens on seventeen cancellations going back to August, which is how it stops being
        // read at all.
        sql`${bookings.startTime} >= ${REVIEW_STARTED_AT.toISOString()}::timestamptz`,
        // Late, or a no-show. A cancellation with proper notice handed the slot back in time
        // for somebody else and is nobody's decision — see `cancelledLate`. Expressed in SQL
        // rather than filtered afterwards so the count on the page is the count in the list.
        sql`(
          ${bookings.status} = 'no_show'
          OR (${bookings.cancelledAt} IS NOT NULL
              AND ${bookings.startTime} - ${bookings.cancelledAt}
                  < make_interval(hours => (SELECT late_cancellation_hours FROM platform_settings WHERE id = 1)))
        )`,
        isNull(bookings.rentalReviewedAt),
        // A waived fee is a decision on the record, not an oversight.
        isNull(bookings.rentWaivedAt),
        // ...and neither is a refunded one. A session that WAS charged and has been given back
        // nets to zero and is settled — it must leave without a flag saying so, which is the
        // property the derived queue is built on. Dropping this when the "is money held?"
        // filter went would have left every refund sitting in the list for ever.
        sql`NOT (
          exists (
            select 1 from ledger_entries le
             where le.subject_type = 'booking' and le.subject_id = bookings.id
               and le.source = 'rental_fee' and le.entry_type = 'purchase'
          )
          AND coalesce((
            select round(sum(l.gross_amount) * 100)::int from ledger_entries l
             where l.subject_type = 'booking' and l.subject_id = bookings.id
               and l.source = 'rental_fee'
          ), 0) <= 0
        )`,
      ),
    )
    .orderBy(asc(bookings.startTime))

  // Priced in TypeScript, not in the query. A service's fee is its TIER's fee, and the
  // name-to-tier map lives in `lib/rental-fees.ts` because the ETL truncates the catalogue —
  // there is no key in the database to join on. One schedule load, mapped in code.
  const schedule = await getLiveSchedule()
  const sharePct = await getProviderSharePct()

  /** What this session would cost the provider if Keoni decides it is owed for.
   *
   *  Two derivations, one question. A provider on rent owes the published fee for the service's
   *  tier. A provider on the 50/50 owes Melanite's half of their own price — their client has
   *  not paid either, so this is not a refund, it is the same debt arrived at differently. */
  const dueFor = (r: { serviceName: string; revenueModel: string; bookedPrice: string | null }) => {
    if (sharesRevenue(r.revenueModel as never)) {
      return Math.round(Number(r.bookedPrice ?? 0) * 100 * (1 - sharePct))
    }
    const tier = tierForService(r.serviceName)
    if (!tier) return 0
    return schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents
  }

  return rows
    .map((r) => ({
      kind: 'held_rent' as const,
      id: r.id,
      // The appointment's own time, not when it was cancelled. Age here means "how long has this
      // provider been waiting to hear", and the session is what they are waiting about.
      since: r.startTime,
      waitingDays: 0,
      // The amount at stake, taken or not. `heldCents` is what has actually moved; `dueCents`
      // is what the session costs if Keoni decides it is owed for.
      amount: r.heldSession
        ? '0.00'
        : (
            (Number(r.heldCents) > 0 ? Number(r.heldCents) : dueFor(r)) / 100
          ).toFixed(2),
      who: `${r.firstName} ${r.lastName}`,
      detail:
        `${r.status === 'no_show' ? 'No-show' : 'Cancelled'} · ${r.serviceName} on ` +
        `${dateLabel(r.startTime.toISOString().slice(0, 10))}` +
        (r.heldSession ? ' · paid with a pack session' : '') +
        (sharesRevenue(r.revenueModel as never) ? ' · 50/50, Melanite’s half of their price' : '') +
        ` — they said: “${r.reason ?? 'nothing recorded'}”`,
      meta: {
        bookingStatus: r.status,
        outcomeReason: r.reason,
        heldSession: r.heldSession ? 'yes' : null,
        /** Whether the money has already moved, which decides which way the buttons point. */
        rentTaken: r.heldSession || Number(r.heldCents) > 0 ? 'yes' : null,
        /** Which arrangement the provider is on, so the row can say what the figure means. */
        model: sharesRevenue(r.revenueModel as never) ? 'split' : 'rental',
      },
    }))
}

/** Sessions that HAPPENED, for a provider whose rent is half their own price.
 *
 *  The only kind here that is not an exception. Every other item in this queue is something that
 *  went wrong — a failed card, a cancelled course, a session nobody turned up for. These are
 *  ordinary sessions that went perfectly well, and they are here because of who worked them.
 *
 *  WHY THEY CANNOT BE SWEPT. There is no figure to sweep with. Melanite derives nothing for
 *  Leyla, Brittany and Karly: they send Keoni the receipt for what they charged their client
 *  and she sets what is owed from it.
 *
 *  It briefly derived half of their own list price, and that came out on 19 October. The list
 *  is theirs to maintain, so half of it was the payer's own number wearing Melanite's
 *  authority — right only while the list matched what the client was actually charged, which
 *  Melanite has no way to see. Keoni would rather read the receipt than track their pricing.
 *  The sweep is closed to them in `lib/rental/settle.ts`; this is where they go instead.
 *
 *  Derived, like everything else in this file. An item leaves when it is charged (a ledger row
 *  appears) or waived — no flag says "done", because a flag can disagree with the money.
 *
 *  The grace period is the same twelve hours a provider has to call a session off. Before that
 *  it may still become a cancellation, and asking Keoni to price something that might not have
 *  happened is how a queue fills with work that evaporates.
 */
export async function rentToConfirm(): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: bookings.id,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      serviceName: services.name,
      firstName: providers.firstName,
      lastName: providers.lastName,
      providerId: bookings.providerId,
      /** The figure Keoni has set, or null if she has not yet. THE ONLY SOURCE of the amount
       *  for these three — nothing is derived, so there is no fallback behind it. */
      overrideCents: bookings.feeOverrideCents,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(bookings.paymentSource, 'rental'),
        eq(providers.rentBasis, 'keoni_sets'),
        // It happened. Cancelled and missed sessions are a different question and a different
        // kind — see `heldRent`.
        sql`${bookings.status} IN ('upcoming', 'completed')`,
        // Keyed on TIME, not on anybody pressing Completed. The same reasoning the sweep uses:
        // bookings rot in `upcoming`, and billing cannot wait for a button nobody presses.
        sql`${bookings.endTime} < now() - ${sql.raw(`interval '${CLOSEOUT_GRACE_HOURS} hours'`)}`,
        sql`${bookings.startTime} >= ${REVIEW_STARTED_AT.toISOString()}::timestamptz`,
        isNull(bookings.rentWaivedAt),
        sql`NOT EXISTS (
          select 1 from ledger_entries le
           where le.subject_type = 'booking' and le.subject_id = bookings.id
             and le.source = 'rental_fee' and le.entry_type = 'purchase'
        )`,
        sql`NOT EXISTS (
          select 1 from provider_pack_redemptions r
           where r.booking_id = bookings.id and r.voided_at is null
        )`,
      ),
    )
    .orderBy(asc(bookings.endTime))

  return rows.map((r) => {
    // NO DERIVED FALLBACK. Null until Keoni has read the receipt and typed a number, and the
    // row says so rather than showing a plausible figure nobody stands behind. An amount of
    // "0.00" would be read as "this session is free"; "awaiting" cannot be misread.
    const cents = r.overrideCents

    return {
      kind: 'rent_to_confirm' as const,
      id: r.id,
      // The session, not the moment it became due. "Waiting since" should mean how long the
      // provider has been waiting to know what they owe.
      since: r.endTime,
      waitingDays: 0,
      amount: cents === null ? '' : (cents / 100).toFixed(2),
      who: `${r.firstName} ${r.lastName}`,
      detail:
        `${r.serviceName} on ${dateLabel(r.startTime.toISOString().slice(0, 10))}` +
        (cents === null
          ? ' — waiting on their receipt, then your figure'
          : ' — you have set a figure'),
      meta: {
        adjusted: cents === null ? null : 'yes',
      },
    }
  })
}

async function cancelledCourseDeposits(): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: trainingEnrollments.id,
      firstName: trainingEnrollments.firstName,
      lastName: trainingEnrollments.lastName,
      email: trainingEnrollments.email,
      courseId: trainingCourses.id,
      day1Date: trainingCourses.day1Date,
      createdAt: trainingEnrollments.createdAt,
      paid: sql<string>`coalesce((
        select sum(case when l.entry_type = 'refund' then -l.gross_amount else l.gross_amount end)
        from ledger_entries l
        where l.subject_type = 'training_enrollment'
          and l.subject_id = training_enrollments.id
      ), 0)`,
    })
    .from(trainingEnrollments)
    .innerJoin(trainingCourses, eq(trainingEnrollments.trainingCourseId, trainingCourses.id))
    .where(eq(trainingCourses.status, 'cancelled'))
    .orderBy(asc(trainingEnrollments.createdAt))

  // Only the ones still holding money. A student already refunded in full has nothing to decide.
  return rows
    .filter((r) => Number(r.paid) > 0)
    .map((r) => ({
      kind: 'cancelled_course_deposit' as const,
      id: r.id,
      since: r.createdAt,
      waitingDays: 0,
      amount: Number(r.paid).toFixed(2),
      who: `${r.firstName} ${r.lastName}`,
      detail: `Paid toward the cancelled course on ${dateLabel(r.day1Date)} — refund or move to another date`,
      meta: { email: r.email, courseId: r.courseId },
    }))
}

export async function getReviewQueue(now: Date = new Date()): Promise<QueueItem[]> {
  const [rooms, deposits, rent, confirm] = await Promise.all([
    roomRefunds(),
    cancelledCourseDeposits(),
    heldRent(),
    rentToConfirm(),
  ])

  // Oldest first across all three. Age is what matters in a queue — the thing waiting longest
  // is the thing most likely to have been forgotten.
  return [...rooms, ...deposits, ...rent, ...confirm]
    .sort((a, b) => a.since.getTime() - b.since.getTime())
    .map((item) => ({
      ...item,
      waitingDays: Math.max(
        Math.floor((now.getTime() - item.since.getTime()) / 86_400_000),
        0,
      ),
    }))
}

/** Courses a cancelled-course student could be moved to. */
export async function getTransferTargets(today: string) {
  return db
    .select({
      id: trainingCourses.id,
      day1Date: trainingCourses.day1Date,
    })
    .from(trainingCourses)
    .where(and(eq(trainingCourses.status, 'scheduled'), sql`${trainingCourses.day1Date} >= ${today}`))
    .orderBy(asc(trainingCourses.day1Date))
}

const slotLabel = (slot: string) =>
  slot === 'full' ? 'Full day' : slot === 'am' ? 'Morning' : 'Afternoon'

const dateLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
