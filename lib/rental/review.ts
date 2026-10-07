import 'server-only'

import { and, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providerPackRedemptions } from '@/lib/db/schema'

import { releaseRentalForBooking, type RentalReleaseResult } from './release'

// Who decides whether a provider gets the rent back.
//
// Keoni does. Nothing else, and nothing automatically.
//
// This replaces the rule the code shipped with, which was that a no-show or a cancellation
// refunded the fee on the spot. Her reason for changing it, in her words: "sometimes its the
// clients fault, and not the providers". The software cannot see whose fault it was, and the
// previous behaviour quietly assumed the answer every time — always the client's, always a
// refund. A provider who simply stopped turning up was refunded as reliably as one whose client
// cancelled on them.
//
// So the fee is taken when the slot is reserved and it STAYS taken until a human says otherwise.
// The appointment is cancelled either way and the slot reopens immediately; only the money
// waits.
//
// WHY HOLD RATHER THAN REFUND-AND-RECHARGE. The other shape — give it back now, take it again if
// Keoni decides the provider was at fault — needs an off-session charge against a saved card for
// an appointment that did not happen. That is the most likely charge in the system to be
// declined, the hardest to explain, and it would show the provider two transactions for one
// session. Holding costs nothing and moves no money until the decision is made.

/** What a provider has riding on a booking that did not happen. */
export type HeldRental =
  /** Money on the card, in cents. A decision to refund gives this back. */
  | { kind: 'card'; cents: number }
  /** A session off a pack. A decision to refund puts it back on the pack.
   *
   *  Only Karly's grandfathered sessions, granted at cutover because her clients had already
   *  bought them under the old model. Rare, finite, and gone once they are used — but a pack
   *  session is worth real money to her, so it gets the same review as a card charge rather
   *  than being swept up as "nothing was charged". */
  | { kind: 'pack' }

/**
 * Whether this booking is holding anything a decision could give back.
 *
 * Null covers every appointment that predates the rental model, Melanite's own, the eight
 * external bookings still running to 20 October, and anything paid by a client. Those reach
 * `cancelled` through four other paths that know nothing about rent, and there is nothing for
 * Keoni to decide about them — putting them in her queue would be asking her to adjudicate
 * money that was never taken.
 */
export async function heldRentalFor(bookingId: string): Promise<HeldRental | null> {
  const [row] = await db
    .select({ paymentSource: bookings.paymentSource })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!row || row.paymentSource !== 'rental') return null

  // The pack first, for the reason `releaseRentalForBooking` checks it first: a pack-covered
  // booking has no ledger row at all, so looking for money and finding none would report
  // "nothing held" for a session the provider definitely paid for.
  const [pack] = await db
    .select({ id: providerPackRedemptions.id })
    .from(providerPackRedemptions)
    .where(
      and(
        eq(providerPackRedemptions.bookingId, bookingId),
        isNull(providerPackRedemptions.voidedAt),
      ),
    )
    .limit(1)

  if (pack) return { kind: 'pack' }

  // The purchase net of any refund. Net, not the purchase alone, because a fee already given
  // back is nothing held — and this is what keeps a resolved item out of the queue without a
  // flag saying so.
  const net = await db.execute<{ cents: number | null }>(sql`
    SELECT round(sum(gross_amount) * 100)::int AS cents
      FROM ledger_entries
     WHERE subject_type = 'booking' AND subject_id = ${bookingId}::uuid
       AND source = 'rental_fee'
  `)

  const cents = net.rows?.[0]?.cents ?? null
  return cents !== null && cents > 0 ? { kind: 'card', cents } : null
}

export type ReviewDecision = 'refund' | 'keep'

export type ReviewResult = { refunded: RentalReleaseResult } | { kept: true } | { error: string }

/**
 * Settles the held fee, one way or the other.
 *
 * Stamping `rentalReviewedAt` is what takes the item off Keoni's list, and it is stamped for a
 * KEEP as well as a refund — "I looked at this and the provider owes it" has to be
 * distinguishable from "nobody has looked yet", or the queue never empties and stops being read.
 * Same reasoning as the `feeWaivedAt` pair this mirrors.
 *
 * The decision itself is not recorded as a value. Refunded or kept is readable from the money:
 * a refund leaves a negative ledger row or a returned pack session, a keep leaves the purchase
 * standing. A stored enum beside those is one more thing that can disagree with them.
 *
 * Safe to call twice. The second call finds `rentalReviewedAt` already set and refuses, which
 * matters more here than in most places — the underlying refund is idempotent, but a double
 * submit that re-stamped the row would overwrite who decided and when.
 */
export async function reviewRentalFee(
  bookingId: string,
  decision: ReviewDecision,
  adminId: string,
): Promise<ReviewResult> {
  const [booking] = await db
    .select({
      status: bookings.status,
      reviewedAt: bookings.rentalReviewedAt,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.reviewedAt) return { error: 'This fee has already been reviewed.' }
  if (booking.status !== 'cancelled' && booking.status !== 'no_show') {
    return { error: 'Only a cancelled or missed appointment has a fee to decide about.' }
  }

  const held = await heldRentalFor(bookingId)
  if (!held) return { error: 'There is nothing held against this appointment.' }

  if (decision === 'keep') {
    await stamp(bookingId, adminId)
    return { kept: true }
  }

  // The refund BEFORE the stamp. The other order would mark the decision made and then
  // discover Stripe would not do it, leaving the item off the queue with the money still held
  // and nobody aware — the one failure here that loses track of real money.
  const released = await releaseRentalForBooking(bookingId)
  if ('error' in released) return { error: released.error }

  await stamp(bookingId, adminId)
  return { refunded: released }
}

async function stamp(bookingId: string, adminId: string): Promise<void> {
  await db
    .update(bookings)
    .set({ rentalReviewedAt: new Date(), rentalReviewedBy: adminId })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.rentalReviewedAt)))
}
