'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { bookings, ledgerEntries, roomBookings, trainingEnrollments } from '@/lib/db/schema'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'
import { toCents } from '@/lib/money'
import { planRefund } from '@/lib/refunds'
import { chargeRentalFee } from '@/lib/rental/charge'
import { notifyRentDecision } from '@/lib/rental/notify-decision'
import { forgetReceipt } from '@/lib/rental/receipts'
import { reviewRentalFee } from '@/lib/rental/review'

export interface QueueState {
  error?: string
  success?: string
}

// Resolving a queue item always ends with the item LEAVING the queue — either the money moved
// or someone recorded a decision not to move it. An action that leaves the row in the same
// state would make the queue lie about what still needs attention.

/** Refunds a late-cancelled room rental, in full or in part. */
export async function refundRoomRental(
  rentalId: string,
  amount: number | null,
): Promise<QueueState> {
  await requireAdmin()

  const [rental] = await db
    .select({
      id: roomBookings.id,
      status: roomBookings.status,
      price: roomBookings.price,
      paymentIntentId: roomBookings.stripePaymentIntentId,
    })
    .from(roomBookings)
    .where(eq(roomBookings.id, rentalId))
    .limit(1)

  if (!rental) return { error: 'That rental does not exist.' }
  if (rental.status !== 'cancellation_requested') {
    return { error: 'That rental has already been resolved.' }
  }

  const full = Number(rental.price)
  const refund = amount === null ? full : amount

  if (!(refund > 0)) return { error: 'Enter an amount greater than zero.' }
  if (refund > full) return { error: `That is more than the ${full.toFixed(2)} paid.` }

  if (!rental.paymentIntentId) {
    return {
      error: 'No Stripe payment is recorded against this rental — refund it by hand and decline here.',
    }
  }
  if (!stripeWritesEnabled()) return { error: 'Payments are not configured in this environment.' }

  try {
    await stripePost(
      '/refunds',
      {
        payment_intent: rental.paymentIntentId,
        amount: Math.round(refund * 100),
        metadata: { reason: 'room_rental_late_cancel_reviewed' },
      },
      // Keyed on the rental AND the amount, so a partial refund followed by a decision to
      // refund the rest is not silently swallowed as a duplicate.
      { idempotencyKey: `room-refund:${rental.id}:${Math.round(refund * 100)}` },
    )
  } catch (err) {
    return { error: friendlyStripeError(err, 'The refund could not be processed.') }
  }

  // The ledger entry is written by the charge.refunded webhook, which mirrors the original
  // purchase. Writing one here as well would double-count.
  await db
    .update(roomBookings)
    .set({ status: refund >= full ? 'refunded' : 'cancelled' })
    .where(eq(roomBookings.id, rental.id))

  revalidatePath('/app/admin/queue')
  return {
    success:
      refund >= full
        ? `Refunded $${full.toFixed(2)} in full.`
        : `Refunded $${refund.toFixed(2)} of $${full.toFixed(2)}.`,
  }
}

/** Records a decision NOT to refund a late-cancelled rental. */
export async function declineRoomRefund(rentalId: string): Promise<QueueState> {
  await requireAdmin()

  const [rental] = await db
    .select({ id: roomBookings.id, status: roomBookings.status })
    .from(roomBookings)
    .where(eq(roomBookings.id, rentalId))
    .limit(1)

  if (!rental) return { error: 'That rental does not exist.' }
  if (rental.status !== 'cancellation_requested') {
    return { error: 'That rental has already been resolved.' }
  }

  await db
    .update(roomBookings)
    .set({ status: 'cancelled' })
    .where(eq(roomBookings.id, rental.id))

  revalidatePath('/app/admin/queue')
  return { success: 'Marked as cancelled with no refund. The provider keeps no charge back.' }
}

/** Refunds a student whose course was cancelled. */
export async function refundEnrollment(
  enrollmentId: string,
  amount: number | null,
): Promise<QueueState> {
  await requireAdmin()

  // The payment intents live on the ledger, not the enrolment — v1 kept them on the row and
  // could only ever reverse the most recent one.
  const entries = await db
    .select({
      paymentIntentId: ledgerEntries.stripePaymentIntentId,
      gross: ledgerEntries.grossAmount,
      entryType: ledgerEntries.entryType,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'training_enrollment'),
        eq(ledgerEntries.subjectId, enrollmentId),
      ),
    )

  if (!stripeWritesEnabled()) return { error: 'Payments are not configured in this environment.' }

  // A deposit and a balance are two separate charges, so a full refund means reversing both.
  // The arithmetic lives in lib/refunds.ts, in integer cents, where it can be tested.
  const plan = planRefund(
    entries.map((e) => ({
      paymentIntentId: e.paymentIntentId ?? '',
      gross: e.gross,
      entryType: e.entryType,
    })),
    amount === null ? null : toCents(amount),
  )

  if ('error' in plan) return { error: plan.error }

  let refundedCents = 0
  for (const charge of plan.charges) {
    try {
      await stripePost(
        '/refunds',
        {
          payment_intent: charge.paymentIntentId,
          amount: charge.amountCents,
          metadata: { reason: 'training_course_cancelled' },
        },
        { idempotencyKey: `training-refund:${charge.paymentIntentId}:${charge.amountCents}` },
      )
    } catch (err) {
      return {
        error: friendlyStripeError(
          err,
          `Refunded ${(refundedCents / 100).toFixed(2)} before failing. Check Stripe.`,
        ),
      }
    }
    refundedCents += charge.amountCents
  }

  revalidatePath('/app/admin/queue')
  return { success: `Refunded $${(plan.totalCents / 100).toFixed(2)}.` }
}

/** Moves a student from a cancelled course onto a scheduled one, keeping what they paid. */
export async function transferEnrollment(
  enrollmentId: string,
  courseId: string,
): Promise<QueueState> {
  await requireAdmin()

  const [enrollment] = await db
    .select({ id: trainingEnrollments.id, email: trainingEnrollments.email })
    .from(trainingEnrollments)
    .where(eq(trainingEnrollments.id, enrollmentId))
    .limit(1)

  if (!enrollment) return { error: 'That enrolment does not exist.' }
  if (!courseId) return { error: 'Choose a course to move them to.' }

  // The ledger entries follow the enrolment id, so moving the enrolment carries the money with
  // it — no refund, no re-charge, and the student's balance stays correct against the new
  // course's price.
  await db
    .update(trainingEnrollments)
    .set({ trainingCourseId: courseId })
    .where(eq(trainingEnrollments.id, enrollment.id))

  revalidatePath('/app/admin/queue')
  revalidatePath('/app/admin/training')
  return { success: 'Moved to the new course, with what they paid carried across.' }
}

// ---------------------------------------------------------------------------------------------
// Rent held on a session that did not happen.
//
// The two below are the whole of Keoni's answer to "how do we handle cancellations?": she reads
// what the provider said and decides. Nothing in the system decides for her, which is the point
// — the automatic no-show refund it replaced was deciding every time, always the same way, on no
// information at all.
//
// The DIRECTION inverted on 12 October, when rent moved to being taken after the session. The
// usual case is now a fee that was never taken, so the question is whether to take it rather
// than whether to give it back — which is the safer way round, because Melanite never has to
// claw money back from somebody who has already spent it.
//
// Both end with `rentalReviewedAt` stamped, so the item leaves the queue either way. "She looked
// at it and the fee stands" has to be distinguishable from "nobody has looked".
// ---------------------------------------------------------------------------------------------

/** Takes the fee for a session that did not happen, or gives back one already taken.
 *
 *  ONE BUTTON, TWO DIRECTIONS, because which way the money goes depends on whether the sweep had
 *  reached the session before it was cancelled — an accident of timing that Keoni should not have
 *  to think about. She is answering one question: is this session owed for? */
export async function collectOwedRent(bookingId: string): Promise<QueueState> {
  const admin = await requireAdmin()

  const out = await reviewRentalFee(bookingId, 'collect', admin.id)
  revalidatePath('/app/admin/queue')
  revalidatePath('/app/charges')

  if ('error' in out) return { error: out.error }
  if (!('collected' in out)) return { error: 'Nothing was charged.' }

  const amount = `$${(out.collected / 100).toFixed(2)}`
  await notifyRentDecision(bookingId, { charged: amount, invoiced: out.invoiced })

  return {
    success: out.invoiced
      ? `${amount} added to what ${'they'} owe — it shows on the revenue page to collect. The provider has been told.`
      : `${amount} charged. The provider has been told.`,
  }
}

/** Decides the session is not owed for: a fee already taken is refunded, a pack session goes
 *  back on the pack, and one never taken is simply never taken.
 *
 *  The provider is told either way, because a decision they never hear about is the same to them
 *  as one nobody made. */
export async function waiveOwedRent(bookingId: string): Promise<QueueState> {
  const admin = await requireAdmin()

  const out = await reviewRentalFee(bookingId, 'release', admin.id)
  revalidatePath('/app/admin/queue')
  revalidatePath('/app/charges')

  if ('error' in out) return { error: out.error }

  if ('released' in out) {
    const released = out.released
    if ('returnedSession' in released) {
      await notifyRentDecision(bookingId, { refunded: 'session' })
      return { success: 'Session returned to the pack. The provider has been told.' }
    }
    if ('refundedCents' in released) {
      const amount = `$${(released.refundedCents / 100).toFixed(2)}`
      await notifyRentDecision(bookingId, { refunded: amount })
      return { success: `${amount} refunded. The provider has been told.` }
    }
  }

  await notifyRentDecision(bookingId, { waived: true })
  return { success: 'Nothing charged for that session. The provider has been told.' }
}

// ---------------------------------------------------------------------------------------------
// Rent on a session that DID happen, for a provider billed half their own price.
//
// The only pair here that is not about something going wrong. Leyla, Brittany and Karly pay half
// of what they charge their own client, read from a price list they maintain themselves — so the
// figure Melanite derives is a number the payer chose. Keoni's answer on 14 October was that they
// send her the receipt and she confirms the amount before the card is touched.
//
// That is why there is an amount field here and nowhere else in this queue: every other item
// asks whether money should move, and this one asks how much.
// ---------------------------------------------------------------------------------------------

/** Confirms what a session was worth and charges it.
 *
 *  `amount` is null to accept the derived figure, or a dollar amount Keoni has taken off the
 *  receipt the provider sent her.
 *
 *  THE FIGURE IS WRITTEN BEFORE THE CHARGE, not after, because `chargeRentalFee` reads it back
 *  off the booking. Writing it afterwards would charge the derived amount and then record a
 *  different one — the worst of both, where the card says one thing and the books another. */
export async function confirmSessionRent(
  bookingId: string,
  amount: number | null,
): Promise<QueueState> {
  const admin = await requireAdmin()

  if (amount !== null) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: 'Enter what this session was worth, or charge the figure as it stands.' }
    }
    // A ceiling, not a judgement about what is reasonable. It is a typed figure going straight
    // to a real card, and a slipped decimal point is the mistake worth refusing — $1,900 where
    // $190 was meant.
    if (amount > 5000) {
      return { error: 'That is more than $5,000. Check the figure before charging it.' }
    }

    await db
      .update(bookings)
      .set({
        feeOverrideCents: Math.round(amount * 100),
        feeSetBy: admin.id,
        feeSetAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
  }

  const out = await chargeRentalFee(bookingId)
  revalidatePath('/app/admin/queue')
  revalidatePath('/app/charges')

  if ('error' in out) return { error: out.error }
  if ('skipped' in out) return { error: out.skipped }

  // The receipt has done its job, so it stops being held. AFTER the charge and never before:
  // if the card fails she needs the document still there to try again. Best effort by design —
  // see `forgetReceipt`, which never throws, because a cleanup must not undo a payment.
  await forgetReceipt(bookingId)

  // No email from here: `chargeRentalFee` sends the receipt itself, from the one place where the
  // money has definitely moved.
  return { success: `$${(out.charged.amountCents / 100).toFixed(2)} charged. The provider has been told.` }
}

/** Decides a session is not chargeable after all.
 *
 *  Reuses `rentWaivedAt` rather than inventing a second way of saying no — the queue already
 *  reads a waived booking as settled, and two columns meaning the same thing is how one of them
 *  gets forgotten. */
export async function skipSessionRent(bookingId: string): Promise<QueueState> {
  const admin = await requireAdmin()

  await db
    .update(bookings)
    .set({ rentWaivedAt: new Date(), rentWaivedBy: admin.id })
    .where(eq(bookings.id, bookingId))

  revalidatePath('/app/admin/queue')

  // Decided, so the document is no longer needed. Same rule as charging it.
  await forgetReceipt(bookingId)
  await notifyRentDecision(bookingId, { waived: true })

  return { success: 'Nothing charged for that session. The provider has been told.' }
}
