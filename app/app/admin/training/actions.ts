'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { DATE, validateCourse } from '@/lib/validate/training-course'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { getEnrollmentDetail, refreshPaymentStatus } from '@/lib/db/queries/training'
import { ledgerEntries, trainingCourses, trainingEnrollments } from '@/lib/db/schema'
import { sendEmail, trainingBalanceEmail } from '@/lib/email'
import { toCents, toMoney } from '@/lib/money'
import { appOrigin } from '@/lib/stripe/config'

export interface TrainingState {
  error?: string
  success?: string
  url?: string
}


export async function createCourse(input: {
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  maxStudents: number
  depositAmount: number
  totalPrice: number
}): Promise<TrainingState> {
  await requireAdmin()

  const invalid = validateCourse(input)
  if (invalid) return { error: invalid }

  await db.insert(trainingCourses).values({
    day1Date: input.day1Date,
    day1Start: input.day1Start,
    day1End: input.day1End,
    day2Date: input.day2Date || null,
    day2Start: input.day2Start,
    day2End: input.day2End,
    maxStudents: input.maxStudents,
    depositAmount: input.depositAmount.toFixed(2),
    totalPrice: input.totalPrice.toFixed(2),
    status: 'scheduled',
  })

  revalidatePath('/app/admin/training')
  return { success: 'Course scheduled.' }
}

export async function updateCourse(
  courseId: string,
  input: {
    day1Date: string
    day1Start: string
    day1End: string
    day2Date: string | null
    day2Start: string
    day2End: string
    maxStudents: number
    depositAmount: number
    totalPrice: number
  },
): Promise<TrainingState> {
  await requireAdmin()

  const invalid = validateCourse(input)
  if (invalid) return { error: invalid }

  const [course] = await db
    .select({ status: trainingCourses.status })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, courseId))
    .limit(1)

  if (!course) return { error: 'That course does not exist.' }
  if (course.status !== 'scheduled') {
    // Repricing a finished course would change what its students are recorded as owing,
    // retroactively, against money already collected.
    return { error: 'Only a scheduled course can be edited.' }
  }

  await db
    .update(trainingCourses)
    .set({
      day1Date: input.day1Date,
      day1Start: input.day1Start,
      day1End: input.day1End,
      day2Date: input.day2Date || null,
      day2Start: input.day2Start,
      day2End: input.day2End,
      maxStudents: input.maxStudents,
      depositAmount: input.depositAmount.toFixed(2),
      totalPrice: input.totalPrice.toFixed(2),
    })
    .where(eq(trainingCourses.id, courseId))

  revalidatePath('/app/admin/training')
  revalidatePath(`/app/admin/training/${courseId}`)
  return { success: 'Course updated.' }
}

/** Closes a course and stamps every enrolment as completed.
 *
 *  v1's note is worth keeping: NO automatic provider invite. Keoni issues those separately, and
 *  a course finishing is not the same as someone being cleared to practise. */
export async function markCourseComplete(courseId: string): Promise<TrainingState> {
  await requireAdmin()

  const [course] = await db
    .select({ status: trainingCourses.status })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, courseId))
    .limit(1)

  if (!course) return { error: 'That course does not exist.' }
  if (course.status !== 'scheduled') return { error: 'That course is already closed.' }

  await db
    .update(trainingCourses)
    .set({ status: 'completed' })
    .where(eq(trainingCourses.id, courseId))

  await db
    .update(trainingEnrollments)
    .set({ courseCompletedAt: new Date() })
    .where(eq(trainingEnrollments.trainingCourseId, courseId))

  revalidatePath('/app/admin/training')
  revalidatePath(`/app/admin/training/${courseId}`)
  return { success: 'Course marked complete. Provider invites are still sent separately.' }
}

export async function cancelCourse(courseId: string): Promise<TrainingState> {
  await requireAdmin()

  const [course] = await db
    .select({ status: trainingCourses.status })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, courseId))
    .limit(1)

  if (!course) return { error: 'That course does not exist.' }
  if (course.status !== 'scheduled') return { error: 'That course is already closed.' }

  await db
    .update(trainingCourses)
    .set({ status: 'cancelled' })
    .where(eq(trainingCourses.id, courseId))

  revalidatePath('/app/admin/training')
  revalidatePath(`/app/admin/training/${courseId}`)
  // Refunds are deliberately not automatic: deposits may be transferable to another date, and
  // that is a conversation, not a rule.
  return {
    success: 'Course cancelled. Any deposits already taken need refunding or transferring by hand.',
  }
}

/** Sends the student a link to pay what they still owe.
 *
 *  The link is stable and carries no token: it addresses an enrolment id and shows only that
 *  student's balance. Re-sending is safe and expected — v1 built this endpoint specifically to
 *  be re-run. */
export async function sendBalanceLink(enrollmentId: string): Promise<TrainingState> {
  await requireAdmin()

  const enrollment = await getEnrollmentDetail(enrollmentId)
  if (!enrollment) return { error: 'That enrolment does not exist.' }
  if (Number(enrollment.owed) <= 0) return { error: 'Nothing is owed on this enrolment.' }

  const url = `${await appOrigin()}/pay/training/${enrollment.id}`

  let delivered = false
  try {
    const result = await sendEmail({
      to: enrollment.email,
      ...trainingBalanceEmail({
        firstName: enrollment.firstName,
        amount: `$${enrollment.owed}`,
        courseDate: enrollment.day1Date,
        dueDate: enrollment.balanceDueDate,
        url,
      }),
    })
    delivered = result.delivered
  } catch (err) {
    console.error('[email] training balance link failed', err)
  }

  return {
    success: delivered
      ? `Balance link emailed to ${enrollment.email}.`
      : 'Balance link ready — email is not configured, so send it yourself.',
    url,
  }
}

/** Sets when the balance is due. Shown to the student on the balance page. */
export async function setBalanceDueDate(
  enrollmentId: string,
  dueDate: string | null,
): Promise<TrainingState> {
  await requireAdmin()

  if (dueDate && !DATE.test(dueDate)) return { error: 'That date is not valid.' }

  await db
    .update(trainingEnrollments)
    .set({ balanceDueDate: dueDate || null })
    .where(eq(trainingEnrollments.id, enrollmentId))

  revalidatePath('/app/admin/training')
  return { success: dueDate ? 'Due date set.' : 'Due date cleared.' }
}


/**
 * Records training money that did not arrive through Stripe.
 *
 * Cherry above all — the student finances, Cherry pays Melanite by ACH days later, and no
 * webhook ever arrives. Also cash and cheques, which have always been possible and until now
 * had nowhere to go: `recordBookingPayment` and `recordMembershipPayment` existed, and training
 * simply had no equivalent, so a Cherry-funded course could never be marked paid at all.
 *
 * RECORDING IS WHAT SECURES THE SEAT. A seat hold is only consulted while the enrolment is
 * `unpaid` — `releaseExpiredSeats` filters on exactly that — so the moment money is recorded
 * the seat stops depending on a clock and belongs to the student outright. That is the answer
 * to "they were approved, hold their place": record what Cherry is paying.
 *
 * Training is entirely Melanite's revenue: no split, no provider payout, nothing forwarded.
 */
export async function recordTrainingPayment(input: {
  enrollmentId: string
  method: 'cherry' | 'cash' | 'check' | 'other'
  amount: number
  externalReference: string | null
  note: string | null
}): Promise<TrainingState> {
  const admin = await requireAdmin()

  if (!['cherry', 'cash', 'check', 'other'].includes(input.method)) {
    return { error: 'Choose how the payment was made.' }
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { error: 'Enter an amount greater than zero.' }
  }

  const enrollment = await getEnrollmentDetail(input.enrollmentId)
  if (!enrollment) return { error: 'That enrolment does not exist.' }

  // Overpaying is almost always a typo — a repeated entry, or the total typed where the balance
  // belonged. Refusing costs a retype; accepting silently overstates revenue and the ledger is
  // append-only, so it cannot be tidied away afterwards.
  const owed = Number(enrollment.owed)
  if (input.amount > owed) {
    return {
      error: `That is more than the ${`$${owed}`} still owed. Enter the amount actually received.`,
    }
  }

  await db.insert(ledgerEntries).values({
    source: 'training',
    payer: 'student',
    entryType: 'purchase',
    subjectType: 'training_enrollment',
    subjectId: enrollment.id,
    providerId: null,
    grossAmount: toMoney(toCents(input.amount)),
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: toMoney(toCents(input.amount)),
    paymentMethod: input.method,
    externalReference: input.externalReference?.trim() || null,
    // Melanite received it and keeps all of it, so there is nothing outstanding to anybody.
    payoutStatus: 'paid',
    note: input.note?.trim() || null,
    recordedBy: admin.id,
  })

  // Recomputed from the ledger, never incremented — and this is also what takes the enrolment
  // out of `unpaid`, so the seat is no longer held by a timer.
  await refreshPaymentStatus(enrollment.id)

  revalidatePath(`/app/admin/training/${enrollment.courseId}`)
  revalidatePath('/app/admin/revenue')

  const remaining = Math.max(owed - input.amount, 0)
  return {
    success:
      remaining > 0
        ? `Recorded. $${remaining.toFixed(2)} still owed, and the seat is theirs.`
        : 'Recorded — paid in full, and the seat is theirs.',
  }
}
