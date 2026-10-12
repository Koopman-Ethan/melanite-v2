import 'server-only'

import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { tierForService } from '@/lib/rental-fees'
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
  | 'failed_fee'
  | 'cancelled_course_deposit'
  | 'held_rent'

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

async function failedFees(): Promise<QueueItem[]> {
  const rows = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      status: bookings.status,
      startTime: bookings.startTime,
      price: bookings.price,
      failedAt: bookings.feeChargeFailedAt,
      error: bookings.feeChargeError,
      serviceName: services.name,
      firstName: providers.firstName,
      lastName: providers.lastName,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        isNotNull(bookings.feeChargeFailedAt),
        // A waived fee is a decision already made. It stays on the booking as a record and
        // leaves the queue.
        isNull(bookings.feeWaivedAt),
      ),
    )
    .orderBy(asc(bookings.feeChargeFailedAt))

  return rows.map((r) => ({
    kind: 'failed_fee' as const,
    id: r.id,
    since: r.failedAt ?? r.startTime,
    waitingDays: 0,
    amount: r.price,
    who: clientLabel(r.clientName),
    detail: `${r.status === 'no_show' ? 'No-show' : 'Late cancellation'} · ${r.serviceName} with ${r.firstName} ${r.lastName} on ${dateLabel(r.startTime.toISOString().slice(0, 10))} — ${r.error ?? 'the charge did not go through'}`,
    meta: { bookingStatus: r.status },
  }))
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
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(bookings.paymentSource, 'rental'),
        sql`${bookings.status} IN ('cancelled', 'no_show')`,
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
  const dueFor = (serviceName: string): number => {
    const tier = tierForService(serviceName)
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
            (Number(r.heldCents) > 0 ? Number(r.heldCents) : dueFor(r.serviceName)) / 100
          ).toFixed(2),
      who: `${r.firstName} ${r.lastName}`,
      detail:
        `${r.status === 'no_show' ? 'No-show' : 'Cancelled'} · ${r.serviceName} on ` +
        `${dateLabel(r.startTime.toISOString().slice(0, 10))}` +
        (r.heldSession ? ' · paid with a pack session' : '') +
        ` — they said: “${r.reason ?? 'nothing recorded'}”`,
      meta: {
        bookingStatus: r.status,
        outcomeReason: r.reason,
        heldSession: r.heldSession ? 'yes' : null,
        /** Whether the money has already moved, which decides which way the buttons point. */
        rentTaken: r.heldSession || Number(r.heldCents) > 0 ? 'yes' : null,
      },
    }))
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
  const [rooms, fees, deposits, rent] = await Promise.all([
    roomRefunds(),
    failedFees(),
    cancelledCourseDeposits(),
    heldRent(),
  ])

  // Oldest first across all three. Age is what matters in a queue — the thing waiting longest
  // is the thing most likely to have been forgotten.
  return [...rooms, ...fees, ...deposits, ...rent]
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
