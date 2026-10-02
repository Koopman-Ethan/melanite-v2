import 'server-only'

import { refundRentalFee } from './charge'
import { returnPackSession } from './packs'

// Giving back the rent when the appointment does not happen.
//
// Keoni's rule is that a provider does not owe the fee when their client does not turn up. The
// fee is taken when the slot is RESERVED and a no-show is only known afterwards, so honouring
// that rule means undoing a charge rather than declining to make one — there was no moment at
// which it could have been avoided.
//
// The same applies to a cancellation, and that goes slightly beyond what Keoni said out loud.
// The reasoning: the fee buys use of the laser, and a cancelled booking hands the slot back for
// somebody else to take. Keeping the money would make it a cancellation penalty, which is a
// different thing that nobody has decided to charge. If Melanite later wants one — a late
// cancellation does leave a hole in the day that rarely gets filled — it should be a fee with a
// name and a rule, not this one quietly kept.
//
// TWO WAYS A SESSION WAS PAID FOR, and they are undone differently: a pack session goes back on
// the pack, and a card charge is refunded. Checked in that order because a pack-covered booking
// has no ledger row to refund, so looking for one first would report "nothing to give back" for
// a session that very much was paid for.

export type RentalReleaseResult =
  /** A pack session went back on the pack. */
  | { returnedSession: true }
  /** Money went back on the card. Cents. */
  | { refundedCents: number }
  /** Nothing was owed for this booking in the first place — Melanite's own appointment, or one
   *  made before the rental model. Not an error. */
  | { nothing: string }
  | { error: string }

/**
 * Undoes whatever the provider paid to hold this slot.
 *
 * Safe to call twice. `returnPackSession` is gated on `voided_at IS NULL` and `refundRentalFee`
 * refuses when a refund row already exists, so a double cancel gives nothing back a second time.
 */
export async function releaseRentalForBooking(bookingId: string): Promise<RentalReleaseResult> {
  if (await returnPackSession(bookingId)) {
    return { returnedSession: true }
  }

  const refund = await refundRentalFee(bookingId)

  if ('charged' in refund) {
    // `refundRentalFee` reports the movement, which is negative for a refund. Reported here as
    // a positive amount given back, because that is what it will be called when somebody says
    // it out loud.
    return { refundedCents: Math.abs(refund.charged.amountCents) }
  }
  if ('skipped' in refund) return { nothing: refund.skipped }
  return { error: refund.error }
}
