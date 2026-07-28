import 'server-only'

import { and, asc, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { trainingCourses, trainingEnrollments } from '@/lib/db/schema'

// Training courses and enrolments.
//
// The money is NOT stored on the enrolment row. v1 kept `deposit_amount`, `amount_paid`,
// `balance_due` and two Stripe intent ids there, wrote no ledger entry, and consequently never
// showed a dollar of training revenue in any admin total — $1,400 of it, invisible. Here the
// ledger is the record and every figure below is derived from it, so "paid" cannot drift from
// "there is money against this".

/** Total recorded against an enrolment, net of refunds. Expressed once, used everywhere.
 *
 *  Table names are written out rather than interpolating Drizzle columns. Inside a correlated
 *  subquery Drizzle renders `${trainingCourses.id}` as a bare `"id"`, which then binds to the
 *  subquery's own aliased table instead of the outer one — a silent wrong answer at best, and
 *  here an outright "column does not exist". */
const paidExpr = sql<string>`coalesce((
  select sum(case when l.entry_type = 'refund' then -l.gross_amount else l.gross_amount end)
  from ledger_entries l
  where l.subject_type = 'training_enrollment'
    and l.subject_id = training_enrollments.id
), 0)`

export interface CourseSummary {
  id: string
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  maxStudents: number
  depositAmount: string
  totalPrice: string
  status: string
  enrolled: number
  /** Sum across every enrolment on the course. */
  collected: string
  outstanding: string
}

export async function getCourses(limit = 50): Promise<CourseSummary[]> {
  const rows = await db
    .select({
      id: trainingCourses.id,
      day1Date: trainingCourses.day1Date,
      day1Start: trainingCourses.day1Start,
      day1End: trainingCourses.day1End,
      day2Date: trainingCourses.day2Date,
      day2Start: trainingCourses.day2Start,
      day2End: trainingCourses.day2End,
      maxStudents: trainingCourses.maxStudents,
      depositAmount: trainingCourses.depositAmount,
      totalPrice: trainingCourses.totalPrice,
      status: trainingCourses.status,
      enrolled: sql<number>`(
        select count(*)::int from training_enrollments e
        where e.training_course_id = training_courses.id
      )`,
      collected: sql<string>`coalesce((
        select sum(case when l.entry_type = 'refund' then -l.gross_amount else l.gross_amount end)
        from ledger_entries l
        join training_enrollments e on e.id = l.subject_id
        where l.subject_type = 'training_enrollment'
          and e.training_course_id = training_courses.id
      ), 0)`,
    })
    .from(trainingCourses)
    .orderBy(desc(trainingCourses.day1Date))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    collected: Number(r.collected).toFixed(2),
    // What the enrolled students still owe, not what the course could theoretically bill if it
    // were full — a half-empty course is not "outstanding" on the seats nobody bought.
    outstanding: Math.max(
      Number(r.enrolled) * Number(r.totalPrice) - Number(r.collected),
      0,
    ).toFixed(2),
  }))
}

export interface EnrollmentRow {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  licenseNumber: string | null
  paymentStatus: string
  balanceDueDate: string | null
  courseCompletedAt: Date | null
  createdAt: Date
  paid: string
  owed: string
  providerId: string | null
}

export async function getEnrollments(courseId: string): Promise<EnrollmentRow[]> {
  const [course] = await db
    .select({ totalPrice: trainingCourses.totalPrice })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, courseId))
    .limit(1)

  const rows = await db
    .select({
      id: trainingEnrollments.id,
      firstName: trainingEnrollments.firstName,
      lastName: trainingEnrollments.lastName,
      email: trainingEnrollments.email,
      phone: trainingEnrollments.phone,
      licenseNumber: trainingEnrollments.licenseNumber,
      paymentStatus: trainingEnrollments.paymentStatus,
      balanceDueDate: trainingEnrollments.balanceDueDate,
      courseCompletedAt: trainingEnrollments.courseCompletedAt,
      createdAt: trainingEnrollments.createdAt,
      providerId: trainingEnrollments.providerId,
      paid: paidExpr,
    })
    .from(trainingEnrollments)
    .where(eq(trainingEnrollments.trainingCourseId, courseId))
    .orderBy(asc(trainingEnrollments.createdAt))

  const total = Number(course?.totalPrice ?? 0)

  return rows.map((r) => ({
    ...r,
    paid: Number(r.paid).toFixed(2),
    owed: Math.max(total - Number(r.paid), 0).toFixed(2),
  }))
}

export interface PublicCourse {
  id: string
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  depositAmount: string
  totalPrice: string
  seatsLeft: number
}

/** Courses a member of the public can still book onto.
 *
 *  Capacity counts enrolments that have paid something, matching v1: an abandoned form should
 *  not hold a seat, and someone who paid a deposit has one. */
export async function getUpcomingCourses(today: string): Promise<PublicCourse[]> {
  const rows = await db
    .select({
      id: trainingCourses.id,
      day1Date: trainingCourses.day1Date,
      day1Start: trainingCourses.day1Start,
      day1End: trainingCourses.day1End,
      day2Date: trainingCourses.day2Date,
      day2Start: trainingCourses.day2Start,
      day2End: trainingCourses.day2End,
      depositAmount: trainingCourses.depositAmount,
      totalPrice: trainingCourses.totalPrice,
      maxStudents: trainingCourses.maxStudents,
      taken: trainingCourses.seatsTaken,
    })
    .from(trainingCourses)
    .where(and(eq(trainingCourses.status, 'scheduled'), gte(trainingCourses.day1Date, today)))
    .orderBy(asc(trainingCourses.day1Date))

  return rows
    // seatsLeft comes from the same counter the claim checks, not from a separate count. Two
    // numbers that are supposed to agree eventually do not.
    .map(({ maxStudents, taken, ...c }) => ({ ...c, seatsLeft: maxStudents - Number(taken) }))
    .filter((c) => c.seatsLeft > 0)
}

export interface EnrollmentDetail {
  id: string
  firstName: string
  lastName: string
  email: string
  paymentStatus: string
  balanceDueDate: string | null
  courseId: string
  day1Date: string
  day2Date: string | null
  totalPrice: string
  depositAmount: string
  courseStatus: string
  paid: string
  owed: string
}

/** One enrolment with its course, for the public balance page. */
export async function getEnrollmentDetail(id: string): Promise<EnrollmentDetail | null> {
  const [row] = await db
    .select({
      id: trainingEnrollments.id,
      firstName: trainingEnrollments.firstName,
      lastName: trainingEnrollments.lastName,
      email: trainingEnrollments.email,
      paymentStatus: trainingEnrollments.paymentStatus,
      balanceDueDate: trainingEnrollments.balanceDueDate,
      courseId: trainingCourses.id,
      day1Date: trainingCourses.day1Date,
      day2Date: trainingCourses.day2Date,
      totalPrice: trainingCourses.totalPrice,
      depositAmount: trainingCourses.depositAmount,
      courseStatus: trainingCourses.status,
      paid: paidExpr,
    })
    .from(trainingEnrollments)
    .innerJoin(trainingCourses, eq(trainingEnrollments.trainingCourseId, trainingCourses.id))
    .where(eq(trainingEnrollments.id, id))
    .limit(1)

  if (!row) return null

  return {
    ...row,
    paid: Number(row.paid).toFixed(2),
    owed: Math.max(Number(row.totalPrice) - Number(row.paid), 0).toFixed(2),
  }
}

/** Recomputes payment status from the ledger.
 *
 *  Called after every training payment. Derived rather than incremented: a status set by adding
 *  to a running total drifts the moment one webhook is replayed or one refund is issued, and v1
 *  maintained exactly such a running total on the enrolment row. */
export async function refreshPaymentStatus(enrollmentId: string): Promise<void> {
  await db.execute(sql`
    UPDATE training_enrollments e
       SET payment_status = CASE
             WHEN paid.total >= c.total_price THEN 'paid_in_full'::training_payment_status
             WHEN paid.total > 0 THEN 'partial'::training_payment_status
             ELSE 'unpaid'::training_payment_status
           END
      FROM training_courses c,
           LATERAL (
             SELECT coalesce(sum(
               CASE WHEN l.entry_type = 'refund' THEN -l.gross_amount ELSE l.gross_amount END
             ), 0) AS total
             FROM ledger_entries l
             WHERE l.subject_type = 'training_enrollment' AND l.subject_id = e.id
           ) paid
     WHERE e.id = ${enrollmentId}
       AND c.id = e.training_course_id
  `)

  // Payment state just changed, so the seat count follows it. This is the single choke point
  // for that — every path that alters what a student has paid comes through here, so
  // reconciling from this one place is what keeps the counter from drifting.
  await db.execute(sql`
    UPDATE training_courses c
       SET seats_taken = (
         SELECT count(*) FROM training_enrollments e2
          WHERE e2.training_course_id = c.id
            AND (e2.payment_status <> 'unpaid'
                 OR (e2.seat_held_until IS NOT NULL AND e2.seat_held_until > now()))
       )
      FROM training_enrollments e
     WHERE e.id = ${enrollmentId} AND c.id = e.training_course_id
  `)

  // A paid seat is held by the payment, not by the clock — leaving a stale hold on it would
  // make it look claimed twice to anything counting both.
  await db
    .update(trainingEnrollments)
    .set({ seatHeldUntil: null })
    .where(
      and(
        eq(trainingEnrollments.id, enrollmentId),
        sql`${trainingEnrollments.paymentStatus} <> 'unpaid'`,
      ),
    )
}

/** Recomputes a course's seat count from what is actually true.
 *
 *  Exported for the paths that move an enrolment between courses, where the enrolment's own
 *  payment state does not change but two courses' counts do. */
export async function reconcileSeats(courseId: string): Promise<void> {
  await db.execute(sql`
    UPDATE training_courses c
       SET seats_taken = (
         SELECT count(*) FROM training_enrollments e
          WHERE e.training_course_id = c.id
            AND (e.payment_status <> 'unpaid'
                 OR (e.seat_held_until IS NOT NULL AND e.seat_held_until > now()))
       )
     WHERE c.id = ${courseId}
  `)
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/** How long an unpaid enrolment holds its seat.
 *
 *  Long enough to finish a card payment without being rushed, short enough that an abandoned
 *  checkout does not keep a seat off the market for the rest of the day. The room rental uses
 *  the same idea for the same reason. */
export const SEAT_HOLD_MINUTES = 20

/** Releases seats whose hold has lapsed.
 *
 *  Two statements rather than one, and the order matters: the first UPDATE atomically claims
 *  the expired rows by nulling their hold, so only one caller can ever count a given row. The
 *  decrement is then exactly right even if two people run this at the same moment.
 *
 *  Lazy rather than scheduled — a sweep that only runs when someone is actually trying to
 *  enrol needs no cron and cannot silently stop working. */
export async function releaseExpiredSeats(courseId: string): Promise<number> {
  const expired = await db
    .update(trainingEnrollments)
    .set({ seatHeldUntil: null })
    .where(
      and(
        eq(trainingEnrollments.trainingCourseId, courseId),
        eq(trainingEnrollments.paymentStatus, 'unpaid'),
        isNotNull(trainingEnrollments.seatHeldUntil),
        lt(trainingEnrollments.seatHeldUntil, new Date()),
      ),
    )
    .returning({ id: trainingEnrollments.id })

  if (expired.length === 0) return 0

  await db
    .update(trainingCourses)
    .set({ seatsTaken: sql`greatest(${trainingCourses.seatsTaken} - ${expired.length}, 0)` })
    .where(eq(trainingCourses.id, courseId))

  return expired.length
}

/** Takes a seat, atomically. Returns false when the course is full.
 *
 *  The whole fix lives in this one statement. `seats_taken < max_students` is evaluated by
 *  Postgres while holding a row lock on the course, so two simultaneous claims on the last seat
 *  serialise and the second one matches no rows. The previous code read a count in one
 *  statement and acted on it in another, with a Stripe checkout in between — a window of
 *  minutes, not microseconds. */
export async function claimSeat(courseId: string): Promise<boolean> {
  const claimed = await db
    .update(trainingCourses)
    .set({ seatsTaken: sql`${trainingCourses.seatsTaken} + 1` })
    .where(
      and(
        eq(trainingCourses.id, courseId),
        sql`${trainingCourses.seatsTaken} < ${trainingCourses.maxStudents}`,
      ),
    )
    .returning({ seatsTaken: trainingCourses.seatsTaken })

  return claimed.length > 0
}

/** Gives a seat back — an abandoned payment, a refund, a withdrawal. */
export async function releaseSeat(courseId: string): Promise<void> {
  await db
    .update(trainingCourses)
    .set({ seatsTaken: sql`greatest(${trainingCourses.seatsTaken} - 1, 0)` })
    .where(eq(trainingCourses.id, courseId))
}
