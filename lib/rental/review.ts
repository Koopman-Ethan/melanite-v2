import 'server-only'

import { and, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  providerPackRedemptions,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'

import { getProviderSharePct } from '@/lib/db/queries/admin-tools'
import { isHouse, sharesRevenue } from '@/lib/revenue-model'

import { chargeRentalFee } from './charge'
import { releaseRentalForBooking, type RentalReleaseResult } from './release'
import { feeForService } from './schedule'

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

/** What is riding on a booking that did not happen. */
export type RentOwed =
  /** Money already taken. A decision to let it go gives this back. */
  | { kind: 'charged'; cents: number }
  /** Not taken yet, and will not be: the sweep never touches a cancelled or missed session.
   *
   *  THE COMMON CASE SINCE 12 OCTOBER, and the one this type was rewritten for. Rent is now
   *  swept twelve hours after a session ends, so a booking cancelled before then has had
   *  nothing charged — and the old "is money held?" test answered no and quietly let the whole
   *  thing through: no reason asked, no queue item, no sweep. The session simply vanished and
   *  Melanite lost the rent without anybody seeing it. */
  | { kind: 'due'; cents: number }
  /** A session off a pack. Giving it back puts it on the pack.
   *
   *  Only Karly's grandfathered sessions, granted at cutover because her clients had already
   *  bought them under the old model. Rare, finite, and gone once used — but worth real money
   *  to her, so it gets the same review as a card charge. */
  | { kind: 'pack' }

/**
 * What a decision about this booking is actually about.
 *
 * Null covers every appointment that predates the rental model, Melanite's own, the external
 * bookings still running to 20 October, and anything paid by a client. Those reach `cancelled`
 * through four other paths that know nothing about rent, and there is nothing to decide — asking
 * Keoni to adjudicate money that was never owed is how a queue stops being read.
 *
 * Also null once the thing has been settled: refunded, waived, or reviewed. That is what takes
 * an item off the queue without a flag saying it is off.
 */
export async function rentOwedFor(bookingId: string): Promise<RentOwed | null> {
  const [row] = await db
    .select({
      paymentSource: bookings.paymentSource,
      status: bookings.status,
      serviceName: services.name,
      waivedAt: bookings.rentWaivedAt,
      revenueModel: providers.revenueModel,
      /** The provider's own price for this service, for a 50/50 booking. */
      ownPrice: providerServices.price,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!row) return null
  if (row.waivedAt) return null
  if (isHouse(row.revenueModel)) return null

  // A SESSION THAT DID NOT HAPPEN RAISES THE SAME QUESTION IN BOTH MODELS, and that is the
  // thing worth getting right here.
  //
  // It looked at first as though the 50/50 three were different — that Melanite was holding
  // their client's money and the decision was whether to refund it. It is not: under the
  // grandfathered arrangement the provider sends a link and the client pays AFTER the service,
  // exactly as rent is now taken after the session. So at the moment of a cancellation nobody
  // has paid anything, in either model.
  //
  // What Keoni decides is therefore identical: does the PROVIDER owe Melanite a fee for a
  // session that did not happen? And in both cases, if she says yes, recovering it from the
  // client is the provider's own business — Melanite's books are square either way.
  //
  // Only the amount is derived differently: the published rental fee, or Melanite's half of
  // what the provider charges for that service.
  if (sharesRevenue(row.revenueModel)) {
    const price = Number(row.ownPrice ?? 0)
    if (!Number.isFinite(price) || price <= 0) return null

    const sharePct = await getProviderSharePct()
    const owed = Math.round(price * 100 * (1 - sharePct))
    return owed > 0 ? { kind: 'due', cents: owed } : null
  }

  if (row.paymentSource !== 'rental') return null

  // The pack first, for the reason `releaseRentalForBooking` checks it first: a pack-covered
  // booking has no ledger row at all, so looking for money and finding none would report
  // "nothing owed" for a session the provider definitely paid for.
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
  // back is nothing owed.
  const net = await db.execute<{ cents: number | null }>(sql`
    SELECT round(sum(gross_amount) * 100)::int AS cents
      FROM ledger_entries
     WHERE subject_type = 'booking' AND subject_id = ${bookingId}::uuid
       AND source = 'rental_fee'
  `)

  const cents = net.rows?.[0]?.cents ?? null
  if (cents !== null && cents > 0) return { kind: 'charged', cents }
  // Already charged and fully refunded — settled, nothing to decide.
  if (cents !== null && cents <= 0) return null

  // Nothing charged. Still owed, unless the fee cannot be priced at all.
  const due = await feeForService(row.serviceName)
  return due === null ? null : { kind: 'due', cents: due }
}

/** What Keoni can decide. `collect` takes the fee that was never taken; `release` gives back one
 *  that was, or returns a pack session; `waive` records that nothing will be pursued.
 *
 *  THE DIRECTION INVERTED on 12 October. While rent was taken at booking the only question was
 *  whether to give it back. Now a cancelled session has had nothing taken, so the usual question
 *  is whether to take it at all — which is strictly the safer way round, because Melanite never
 *  has to claw money back from somebody who has already spent it. */
export type ReviewDecision = 'collect' | 'release' | 'waive'

export type ReviewResult =
  | { collected: number }
  | { released: RentalReleaseResult }
  | { waived: true }
  | { error: string }

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

  const owed = await rentOwedFor(bookingId)
  if (!owed) return { error: 'There is nothing to decide about this appointment.' }

  if (decision === 'waive') {
    await db
      .update(bookings)
      .set({ rentWaivedAt: new Date(), rentWaivedBy: adminId })
      .where(eq(bookings.id, bookingId))
    await stamp(bookingId, adminId)
    return { waived: true }
  }

  if (decision === 'collect') {
    if (owed.kind !== 'due') {
      return { error: 'That fee has already been taken — release it instead.' }
    }

    // The charge BEFORE the stamp, for the same reason the refund is: stamping first would mark
    // the decision made and then discover the card would not pay, taking the item off the queue
    // with the money still owed and nobody aware.
    const charged = await chargeRentalFee(bookingId)
    if ('error' in charged) return { error: charged.error }
    if ('skipped' in charged) return { error: charged.skipped }

    await stamp(bookingId, adminId)
    return { collected: charged.charged.amountCents }
  }

  // release — give back a fee that was taken, or return a pack session. Nothing was taken when
  // the fee is merely due, so releasing it is the same as waiving it.
  if (owed.kind === 'due') {
    await db
      .update(bookings)
      .set({ rentWaivedAt: new Date(), rentWaivedBy: adminId })
      .where(eq(bookings.id, bookingId))
    await stamp(bookingId, adminId)
    return { waived: true }
  }

  const released = await releaseRentalForBooking(bookingId)
  if ('error' in released) return { error: released.error }

  await stamp(bookingId, adminId)
  return { released }
}

async function stamp(bookingId: string, adminId: string): Promise<void> {
  await db
    .update(bookings)
    .set({ rentalReviewedAt: new Date(), rentalReviewedBy: adminId })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.rentalReviewedAt)))
}
