'use server'

import { and, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  SEAT_HOLD_MINUTES,
  claimSeat,
  getEnrollmentDetail,
  releaseExpiredSeats,
  releaseSeat,
} from '@/lib/db/queries/training'
import { trainingCourses, trainingEnrollments } from '@/lib/db/schema'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'

// PUBLIC — no session. Anyone can enrol; that is the point of a training course.
//
// Training is the one revenue stream where the payer is not a client or a provider but a
// STUDENT, and where the money is 100% Melanite's: no split, no Connect transfer, no
// destination charge. Getting that wrong would pay a provider for a course they did not teach.

export interface EnrollState {
  clientSecret?: string
  enrollmentId?: string
  amount?: number
  error?: string
}

/** The payment methods Melanite accepts, stated explicitly.
 *
 *  NOT `automatic_payment_methods` — that hands the choice to Stripe, which surfaces whatever
 *  it thinks converts (Klarna, Afterpay, Cash App) and cannot be reliably suppressed from the
 *  Dashboard, since those toggles are per-mode and interact with automatic methods in ways that
 *  look like they have not taken effect. An explicit list is deterministic: what is here is
 *  what a client sees.
 *
 *  Buy-now-pay-later is deliberately absent. Melanite's financing partner is Cherry, and a
 *  competing BNPL button beside it splits the one route the business actually has a
 *  relationship with. v1 used this same explicit pair.
 *
 *  Card covers Apple Pay and Google Pay — those ride on the card rail, not separate types. */
const PAYMENT_METHODS = ['card', 'link'] as const

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function enrollAndPayDeposit(input: {
  courseId: string
  firstName: string
  lastName: string
  email: string
  phone: string
  licenseNumber: string
  payInFull: boolean
}): Promise<EnrollState> {
  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const email = input.email.trim().toLowerCase()

  if (!firstName || !lastName) return { error: 'Enter your first and last name.' }
  if (!EMAIL.test(email)) return { error: 'Enter a valid email address.' }
  if (!input.phone.trim()) return { error: 'Enter a phone number.' }
  // Required, not optional. This is a clinical laser course — who is being trained, and under
  // what license, is the record Melanite has to be able to produce later.
  if (!input.licenseNumber.trim()) {
    return { error: 'Enter your professional license number.' }
  }

  const [course] = await db
    .select({
      id: trainingCourses.id,
      status: trainingCourses.status,
      maxStudents: trainingCourses.maxStudents,
      depositAmount: trainingCourses.depositAmount,
      totalPrice: trainingCourses.totalPrice,
      day1Date: trainingCourses.day1Date,
    })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, input.courseId))
    .limit(1)

  if (!course) return { error: 'That course does not exist.' }
  if (course.status !== 'scheduled') return { error: 'That course is no longer open.' }

  // Abandoned checkouts give their seats back before anyone else is told the course is full.
  await releaseExpiredSeats(course.id)

  // Re-enrolling with the same email reuses the row rather than creating a second seat for the
  // same person — v1 refused with ALREADY_ENROLLED, which strands anyone whose first payment
  // attempt failed.
  const [existing] = await db
    .select({
      id: trainingEnrollments.id,
      paymentStatus: trainingEnrollments.paymentStatus,
      seatHeldUntil: trainingEnrollments.seatHeldUntil,
    })
    .from(trainingEnrollments)
    .where(
      and(
        eq(trainingEnrollments.trainingCourseId, course.id),
        eq(trainingEnrollments.email, email),
      ),
    )
    .limit(1)

  if (existing && existing.paymentStatus !== 'unpaid') {
    return { error: 'You are already enrolled on this course. Check your email for your balance link.' }
  }

  // Somebody retrying inside their own hold window already has a seat; claiming a second one
  // would let one person eat two places on a five-seat course.
  const alreadyHolding = Boolean(existing?.seatHeldUntil && existing.seatHeldUntil > new Date())

  if (!alreadyHolding && !(await claimSeat(course.id))) {
    return { error: 'This course is now full. Contact Melanite about the next date.' }
  }

  const heldUntil = new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000)

  let enrollmentId = existing?.id
  if (enrollmentId) {
    await db
      .update(trainingEnrollments)
      .set({
        firstName,
        lastName,
        phone: input.phone.trim(),
        licenseNumber: input.licenseNumber.trim(),
        seatHeldUntil: heldUntil,
      })
      .where(eq(trainingEnrollments.id, enrollmentId))
  } else {
    const [created] = await db
      .insert(trainingEnrollments)
      .values({
        trainingCourseId: course.id,
        firstName,
        lastName,
        email,
        phone: input.phone.trim(),
        licenseNumber: input.licenseNumber.trim(),
        paymentStatus: 'unpaid',
        seatHeldUntil: heldUntil,
      })
      .returning({ id: trainingEnrollments.id })
    enrollmentId = created.id
  }

  const amountCents = Math.round(
    Number(input.payInFull ? course.totalPrice : course.depositAmount) * 100,
  )
  if (amountCents <= 0) {
    if (!alreadyHolding) await releaseSeat(course.id)
    return { error: 'This course has no price set. Contact Melanite.' }
  }

  try {
    const intent = await stripePost<{ id: string; client_secret: string }>('/payment_intents', {
      amount: amountCents,
      currency: 'usd',
      payment_method_types: PAYMENT_METHODS,
      receipt_email: email,
      // NO transfer_data and NO application_fee: training is entirely Melanite's revenue, so
      // the charge stays on the platform account with nothing forwarded.
      metadata: {
        type: input.payInFull ? 'training_balance' : 'training_deposit',
        training_enrollment_id: enrollmentId,
        training_course_id: course.id,
      },
    })

    return {
      clientSecret: intent.client_secret,
      enrollmentId,
      amount: amountCents / 100,
    }
  } catch (err) {
    // Stripe never got as far as a payment, so the seat goes back now rather than waiting out
    // the hold. Only if this call is what claimed it.
    if (!alreadyHolding) await releaseSeat(course.id)
    return { error: friendlyStripeError(err, 'Could not start the payment. Try again shortly.') }
  }
}

/** Pays whatever is still owed on an enrolment. */
export async function payTrainingBalance(enrollmentId: string): Promise<EnrollState> {
  const enrollment = await getEnrollmentDetail(enrollmentId)
  if (!enrollment) return { error: 'That enrolment does not exist.' }

  const owed = Number(enrollment.owed)
  if (owed <= 0) return { error: 'Nothing is owed on this enrolment.' }

  try {
    const intent = await stripePost<{ id: string; client_secret: string }>('/payment_intents', {
      amount: Math.round(owed * 100),
      currency: 'usd',
      payment_method_types: PAYMENT_METHODS,
      receipt_email: enrollment.email,
      metadata: {
        type: 'training_balance',
        training_enrollment_id: enrollment.id,
        training_course_id: enrollment.courseId,
      },
    })

    return { clientSecret: intent.client_secret, enrollmentId: enrollment.id, amount: owed }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not start the payment. Try again shortly.') }
  }
}
