'use server'

import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  CHERRY_SEAT_HOLD_MINUTES,
  SEAT_HOLD_MINUTES,
  claimSeat,
  getEnrollmentDetail,
  releaseExpiredSeats,
  releaseSeat,
} from '@/lib/db/queries/training'
import { platformSettings, trainingCourses, trainingEnrollments } from '@/lib/db/schema'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'
import { emailError, phoneError } from '@/lib/validation'

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


export interface EnrolInput {
  courseId: string
  firstName: string
  lastName: string
  email: string
  phone: string
  licenseNumber: string
}

interface Reserved {
  course: { id: string; depositAmount: string; totalPrice: string }
  enrollmentId: string
  /** True when the caller found an existing hold rather than taking one. Only the caller that
   *  CLAIMED a seat may release it on failure, or a retry hands back somebody else's. */
  alreadyHolding: boolean
}

/** Validates, claims a seat, and creates or updates the enrolment row.
 *
 *  Shared by both routes deliberately. The card path and the Cherry path must agree about who
 *  is allowed to enrol and what a seat means — two copies of "the licence number is required"
 *  is how one of them quietly stops requiring it.
 *
 *  `holdMinutes` is the one thing they differ on, and it is not a detail. Twenty minutes suits
 *  somebody typing a card number. A financing decision takes days, so a Cherry hand-off holds
 *  the seat far longer — otherwise an approved student comes back to a full course, which is a
 *  worse outcome than holding a seat that might not convert.
 */
async function reserveSeat(
  input: EnrolInput,
  holdMinutes: number,
): Promise<{ error: string } | Reserved> {
  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const email = input.email.trim().toLowerCase()

  if (!firstName || !lastName) return { error: 'Enter your first and last name.' }
  // Shared with the form, so the two cannot disagree. This used to be a private regex here —
  // a second copy of the rule, which is how a browser starts accepting what the server rejects.
  // Blank and malformed get different sentences, as everywhere else. Both are refused: the
  // enrolment confirmation and the balance link are emailed weeks apart, so a typo here is a
  // student who paid a deposit and then hears nothing.
  const emailProblem = emailError(email)
  if (emailProblem) return { error: `${emailProblem} The enrolment link goes there.` }
  const phoneProblem = phoneError(input.phone)
  if (phoneProblem) return { error: phoneProblem }
  // Required, not optional. This is a clinical laser course — who is being trained, and under
  // what license, is the record Melanite has to be able to produce later.
  if (!input.licenseNumber.trim()) {
    return { error: 'Enter your professional license number.' }
  }

  const [course] = await db
    .select({
      id: trainingCourses.id,
      depositAmount: trainingCourses.depositAmount,
      totalPrice: trainingCourses.totalPrice,
      status: trainingCourses.status,
    })
    .from(trainingCourses)
    .where(eq(trainingCourses.id, input.courseId))
    .limit(1)

  // Two messages, not one. A bad id means a broken or stale link; a course that is no longer
  // scheduled is a real course that closed. Collapsing them tells a student with a dead link to
  // look for another date, and a student whose course was cancelled that they mistyped
  // something.
  if (!course) return { error: 'That course does not exist.' }
  if (course.status !== 'scheduled') return { error: 'That course is no longer open.' }

  // Lazy sweep, so an abandoned checkout does not keep a seat off the market until someone
  // remembers to run something.
  await releaseExpiredSeats(course.id)

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

  const heldUntil = new Date(Date.now() + holdMinutes * 60_000)

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

  return { course, enrollmentId, alreadyHolding }
}

export async function enrollAndPayDeposit(
  input: EnrolInput & { payInFull: boolean },
): Promise<EnrollState> {
  const reserved = await reserveSeat(input, SEAT_HOLD_MINUTES)
  if ('error' in reserved) return reserved

  const { course, enrollmentId, alreadyHolding } = reserved
  const email = input.email.trim().toLowerCase()

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

export interface CherryEnrolState {
  error?: string
  /** Where to send them. Null is not an error state the student should ever see — the button
   *  is not rendered when Melanite has no Cherry link configured. */
  cherryUrl?: string
  enrollmentId?: string
}

/**
 * Reserves a seat and hands the student to Cherry.
 *
 * The mirror of the package hand-off, and the same rule governs it: this records an INTENT, not
 * a payment. Nothing is marked paid, no ledger entry is written, and the enrolment stays
 * `unpaid` — because they have applied for financing, not been approved for it, and marking it
 * paid because a button was clicked would be worse than no signal at all.
 *
 * Cherry pays Melanite directly and training is entirely Melanite's revenue, so unlike a
 * booking there is no split to reason about and nobody is owed a share. Keoni records the money
 * when Cherry's ACH lands.
 */
export async function enrollWithCherry(input: EnrolInput): Promise<CherryEnrolState> {
  const [settings] = await db
    .select({ cherryApplyUrl: platformSettings.cherryApplyUrl })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  if (!settings?.cherryApplyUrl) {
    return { error: 'Cherry financing is not available right now. Contact Melanite.' }
  }

  const reserved = await reserveSeat(input, CHERRY_SEAT_HOLD_MINUTES)
  if ('error' in reserved) return reserved

  // Written after the seat is held, and guarded so a student who comes back and clicks again
  // does not reset when they first went — the age of the application is what tells Keoni
  // whether to chase it.
  await db
    .update(trainingEnrollments)
    .set({ cherryStartedAt: new Date() })
    .where(
      and(
        eq(trainingEnrollments.id, reserved.enrollmentId),
        isNull(trainingEnrollments.cherryStartedAt),
      ),
    )

  return { cherryUrl: settings.cherryApplyUrl, enrollmentId: reserved.enrollmentId }
}
