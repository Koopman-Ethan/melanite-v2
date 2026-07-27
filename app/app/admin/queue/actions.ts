'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { bookings, ledgerEntries, roomBookings, trainingEnrollments } from '@/lib/db/schema'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'
import { chargeBookingFee } from '@/lib/stripe/fees'

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

/** Tries the fee again — for a card that has since been replaced or a decline that was temporary. */
export async function retryFee(bookingId: string): Promise<QueueState> {
  await requireAdmin()

  const [booking] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment does not exist.' }

  const kind = booking.status === 'no_show' ? 'no_show_fee' : 'late_cancellation_fee'
  const result = await chargeBookingFee(bookingId, kind)

  revalidatePath('/app/admin/queue')

  if (result.charged) return { success: `Charged $${result.amount}.` }
  return { error: result.error ?? result.skipped ?? 'The charge did not go through.' }
}

/** Records a decision not to pursue the fee. */
export async function waiveFee(bookingId: string): Promise<QueueState> {
  const admin = await requireAdmin()

  await db
    .update(bookings)
    .set({ feeWaivedAt: new Date(), feeWaivedBy: admin.id })
    .where(eq(bookings.id, bookingId))

  revalidatePath('/app/admin/queue')
  return { success: 'Fee waived. It stays on the record as a decision, not an oversight.' }
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

  const purchases = entries.filter((e) => e.entryType === 'purchase' && e.paymentIntentId)
  if (purchases.length === 0) {
    return { error: 'No Stripe payment is recorded for this student — refund by hand.' }
  }
  if (!stripeWritesEnabled()) return { error: 'Payments are not configured in this environment.' }

  const paid = entries.reduce(
    (sum, e) => sum + (e.entryType === 'refund' ? -Number(e.gross) : Number(e.gross)),
    0,
  )
  let remaining = amount === null ? paid : amount

  if (!(remaining > 0)) return { error: 'Enter an amount greater than zero.' }
  if (remaining > paid) return { error: `That is more than the ${paid.toFixed(2)} paid.` }

  // A deposit and a balance are two separate charges, so a full refund means refunding both.
  // Walked newest first purely so a partial refund comes off the most recent payment.
  for (const purchase of [...purchases].reverse()) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Number(purchase.gross))
    if (take <= 0) continue

    try {
      await stripePost(
        '/refunds',
        {
          payment_intent: purchase.paymentIntentId!,
          amount: Math.round(take * 100),
          metadata: { reason: 'training_course_cancelled' },
        },
        { idempotencyKey: `training-refund:${purchase.paymentIntentId}:${Math.round(take * 100)}` },
      )
    } catch (err) {
      return {
        error: friendlyStripeError(
          err,
          `Refunded ${(Number(amount ?? paid) - remaining).toFixed(2)} before failing. Check Stripe.`,
        ),
      }
    }

    remaining -= take
  }

  revalidatePath('/app/admin/queue')
  return { success: `Refunded $${(amount === null ? paid : amount).toFixed(2)}.` }
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
