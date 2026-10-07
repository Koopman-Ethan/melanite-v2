import 'server-only'

import { refundRentalFee } from './charge'
import { returnPackSession } from './packs'

// Giving back the rent. The mechanism, not the policy.
//
// NOTHING CALLS THIS AUTOMATICALLY. It is reachable from exactly one place —
// `reviewRentalFee` in `lib/rental/review.ts`, which runs when Keoni decides — and that is the
// whole design. Up to 7 October `markNoShow` and `cancelBooking` both called it directly, so a
// provider who marked a no-show was refunded on the spot. Keoni withdrew that: "sometimes its
// the clients fault, and not the providers", and the old behaviour assumed the answer every
// time without anybody reading a word.
//
// So this module knows HOW to give the money back and nothing about WHEN. If a new path ever
// needs to refund rent, the question to answer first is who decided — not whether this function
// will do it, which it always will.
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
 * Call it only once somebody has decided it should happen. Safe to call twice:
 * `returnPackSession` is gated on `voided_at IS NULL` and `refundRentalFee` refuses when a refund
 * row already exists, so a second decision gives nothing back a second time.
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
