'use server'

import { and, eq, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { getCheckoutSettings } from '@/lib/db/queries/checkout'
import {
  bookings,
  checkoutLinks,
  clientPackageItems,
  clientPackages,
  packageRedemptions,
} from '@/lib/db/schema'
import { chargeBookingFee } from '@/lib/stripe/fees'

// Ported from v1's three booking-action endpoints. The preconditions are theirs, deliberately
// — they encode real money rules, not incidental validation.

export interface ActionState {
  error?: string
  success?: string
  /** Set when a fee was attempted but nothing was charged — no card, no consent, nothing to
   *  base an amount on. Not an error: the status change still happened, and the provider needs
   *  to know the fee did not. */
  feeNote?: string
}

/** Cancel an ordinary booking.
 *
 *  v1's guard: if a live package redemption points at this booking, this endpoint REFUSES
 *  (USE_PACKAGE_CANCEL) because cancelling here would destroy a session the client already
 *  paid for. That guard is kept — the UI picks the right action from `paymentSource`, but the
 *  server must not depend on the UI having got it right. It fails closed.
 */
export async function cancelBooking(
  bookingId: string,
  chargeLateFee = false,
): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be cancelled.' }
  }

  const [live] = await db
    .select({ id: packageRedemptions.id })
    .from(packageRedemptions)
    .where(
      and(eq(packageRedemptions.bookingId, bookingId), isNull(packageRedemptions.voidedAt)),
    )
    .limit(1)

  if (live) {
    return {
      error:
        'This is a prepaid package session. Use "Cancel and restore session" so the client keeps it.',
    }
  }

  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId))

  // Only a PENDING link is cancelled. A paid one is never silently voided — refunds are
  // handled in Stripe deliberately, so the record of payment has to survive the cancellation.
  await db
    .update(checkoutLinks)
    .set({ status: 'cancelled' })
    .where(and(eq(checkoutLinks.bookingId, bookingId), eq(checkoutLinks.status, 'pending')))

  revalidatePath('/app/appointments')

  // The fee is opt-in per cancellation, never automatic. Charging a card without the provider
  // deciding to is not a default anyone should be able to stumble into.
  if (!chargeLateFee) return { success: 'Appointment cancelled.' }

  const settings = await getCheckoutSettings()
  const hoursOut = (booking.startTime.getTime() - Date.now()) / 3_600_000
  if (hoursOut > settings.lateCancellationHours) {
    return {
      success: 'Appointment cancelled.',
      feeNote: `No fee charged — this was cancelled more than ${settings.lateCancellationHours} hours ahead.`,
    }
  }

  const fee = await chargeBookingFee(bookingId, 'late_cancellation_fee')
  if (fee.charged) {
    return { success: `Appointment cancelled. $${fee.amount} late cancellation fee charged.` }
  }
  return { success: 'Appointment cancelled.', feeNote: fee.error ?? fee.skipped }
}

/** Cancel a package redemption and give the session back.
 *
 *  v1 runs this in a transaction: decrement qty_used (floored at 0), reactivate the package if
 *  it had been exhausted, stamp the redemption voided, then cancel the booking. All four have
 *  to happen together or a client silently loses a paid session.
 *
 *  Locked v1 decisions kept: always restore, with no cancellation-window cutoff; and an
 *  EXPIRED package gets its session back but stays expired.
 */
export async function cancelPackageRedemption(bookingId: string): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be cancelled.' }
  }

  const [redemption] = await db
    .select({
      id: packageRedemptions.id,
      itemId: packageRedemptions.clientPackageItemId,
      packageId: packageRedemptions.clientPackageId,
      packageProviderId: clientPackages.providerId,
      packageStatus: clientPackages.status,
    })
    .from(packageRedemptions)
    .innerJoin(clientPackages, eq(packageRedemptions.clientPackageId, clientPackages.id))
    .where(
      and(eq(packageRedemptions.bookingId, bookingId), isNull(packageRedemptions.voidedAt)),
    )
    .limit(1)

  if (!redemption) return { error: 'This appointment is not a package session.' }
  if (redemption.packageProviderId !== user.id) {
    return { error: 'That package belongs to another provider.' }
  }

  await db.transaction(async (tx) => {
    // Floored at 0 in SQL rather than read-modify-write, so two concurrent cancellations
    // cannot both read the same qty_used and drive it negative.
    await tx
      .update(clientPackageItems)
      .set({ qtyUsed: sql`greatest(${clientPackageItems.qtyUsed} - 1, 0)` })
      .where(eq(clientPackageItems.id, redemption.itemId))

    // An exhausted package becomes usable again now that a session is back. An expired one
    // deliberately stays expired — the session returns, the expiry still stands.
    if (redemption.packageStatus === 'exhausted') {
      await tx
        .update(clientPackages)
        .set({ status: 'active' })
        .where(eq(clientPackages.id, redemption.packageId))
    }

    await tx
      .update(packageRedemptions)
      .set({ voidedAt: new Date() })
      .where(eq(packageRedemptions.id, redemption.id))

    await tx.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId))
  })

  revalidatePath('/app/appointments')
  return { success: 'Appointment cancelled and the session returned to the package.' }
}

/** Mark a past appointment as a no-show.
 *
 *  Status label only — v1 charges no fee here, and that decision is deliberate rather than
 *  unfinished. The booking must already be in the past; labelling a future appointment a
 *  no-show is always a mistake.
 */
export async function markNoShow(
  bookingId: string,
  chargeFee = false,
): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be marked as a no-show.' }
  }
  if (booking.startTime > new Date()) {
    return { error: "That appointment hasn't happened yet." }
  }

  await db.update(bookings).set({ status: 'no_show' }).where(eq(bookings.id, bookingId))

  revalidatePath('/app/appointments')

  if (!chargeFee) return { success: 'Marked as a no-show.' }

  const fee = await chargeBookingFee(bookingId, 'no_show_fee')
  if (fee.charged) {
    return { success: `Marked as a no-show. $${fee.amount} fee charged.` }
  }
  return { success: 'Marked as a no-show.', feeNote: fee.error ?? fee.skipped }
}

/** Mark a past appointment as completed. v1 had no such endpoint — bookings simply stayed
 *  `upcoming` forever, which is a large part of why stale appointments accumulate. */
export async function markCompleted(bookingId: string): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') return { error: 'That appointment is already resolved.' }
  if (booking.startTime > new Date()) {
    return { error: "That appointment hasn't happened yet." }
  }

  await db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, bookingId))

  revalidatePath('/app/appointments')
  return { success: 'Marked as completed.' }
}
