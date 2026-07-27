'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { getEnrollmentDetail } from '@/lib/db/queries/training'
import { trainingCourses, trainingEnrollments } from '@/lib/db/schema'
import { sendEmail, trainingBalanceEmail } from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

export interface TrainingState {
  error?: string
  success?: string
  url?: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}$/

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

  const invalid = validate(input)
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

  const invalid = validate(input)
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

function validate(input: {
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  maxStudents: number
  depositAmount: number
  totalPrice: number
}): string | null {
  if (!DATE.test(input.day1Date)) return 'Pick a date for day one.'
  if (!TIME.test(input.day1Start) || !TIME.test(input.day1End)) return 'Day one times are not valid.'
  if (input.day1End <= input.day1Start) return 'Day one must end after it starts.'

  if (input.day2Date) {
    if (!DATE.test(input.day2Date)) return 'Day two date is not valid.'
    if (input.day2Date < input.day1Date) return 'Day two cannot be before day one.'
    if (!TIME.test(input.day2Start) || !TIME.test(input.day2End)) {
      return 'Day two times are not valid.'
    }
    if (input.day2End <= input.day2Start) return 'Day two must end after it starts.'
  }

  if (!Number.isInteger(input.maxStudents) || input.maxStudents < 1) {
    return 'A course needs at least one seat.'
  }
  if (!(input.totalPrice > 0)) return 'Set a course price.'
  if (input.depositAmount < 0) return 'The deposit cannot be negative.'
  // A deposit larger than the price would leave a negative balance owed, which nothing
  // downstream is prepared to represent.
  if (input.depositAmount > input.totalPrice) {
    return 'The deposit cannot be more than the total price.'
  }

  return null
}
