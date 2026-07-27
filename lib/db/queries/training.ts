import 'server-only'

import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'

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
      taken: sql<number>`(
        select count(*)::int from training_enrollments e
        where e.training_course_id = training_courses.id
          and e.payment_status <> 'unpaid'
      )`,
    })
    .from(trainingCourses)
    .where(and(eq(trainingCourses.status, 'scheduled'), gte(trainingCourses.day1Date, today)))
    .orderBy(asc(trainingCourses.day1Date))

  return rows
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
}
