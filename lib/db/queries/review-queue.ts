import 'server-only'

import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

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
// Three situations can currently arise where the system has deliberately stopped short of
// deciding, because deciding would be wrong:
//
//   1. A room rental cancelled inside 24 hours. The block is freed either way, but whether the
//      provider gets their money back is Keoni's call.
//   2. A no-show or late-cancellation fee that failed to charge — declined card, no card, no
//      consent. The appointment status is already recorded; the money is not.
//   3. A cancelled training course with deposits already taken. They may be refundable or
//      transferable to another date, which is a conversation.
//
// None of these were visible anywhere. v1 surfaced only the first, through a room-rentals
// endpoint filtered on `cancellation_requested`; the other two did not exist because it never
// charged a fee and never cancelled a course in software.
//
// Deliberately DERIVED from the state of the things themselves rather than kept in a queue
// table. A separate work-queue store is one more thing that can disagree with reality, and an
// item that lingers after being resolved is worse than no queue at all.

export type QueueKind = 'room_refund' | 'failed_fee' | 'cancelled_course_deposit'

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
    who: r.clientName,
    detail: `${r.status === 'no_show' ? 'No-show' : 'Late cancellation'} · ${r.serviceName} with ${r.firstName} ${r.lastName} on ${dateLabel(r.startTime.toISOString().slice(0, 10))} — ${r.error ?? 'the charge did not go through'}`,
    meta: { bookingStatus: r.status },
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
  const [rooms, fees, deposits] = await Promise.all([
    roomRefunds(),
    failedFees(),
    cancelledCourseDeposits(),
  ])

  // Oldest first across all three. Age is what matters in a queue — the thing waiting longest
  // is the thing most likely to have been forgotten.
  return [...rooms, ...fees, ...deposits]
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
