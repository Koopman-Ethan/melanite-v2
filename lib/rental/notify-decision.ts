import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providerServices, providers, services } from '@/lib/db/schema'
import { appointmentWhen, rentalDecisionEmail, sendEmail } from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

// Telling a provider what Keoni decided about their held rent.
//
// Its own module rather than another function in `lib/notify-melanite.ts` because it goes the
// other way: everything in there tells Melanite's desk about providers, and this tells a
// provider about Melanite. `notifyProviderCharged` is the only other one of its kind, and the
// reason that file is no longer accurately named.
//
// DELIBERATELY NOT GATED on `notifyBookingConfirmed`, which every other provider-facing email
// respects.
//
// That preference means "do I want a receipt for things I did", and a provider is entitled to
// switch those off. This is not that. It is the outcome of a decision somebody else made about
// money they have already paid, it arrives only because they asked a question by cancelling,
// and the terms they accepted say "You are told either way". A notification preference cannot
// be allowed to make that term false — and unlike a receipt, there is nowhere else this
// information reliably surfaces.

export type RentDecision =
  /** The amount refunded as a display string, or 'session' for a pack session returned. */
  | { refunded: string }
  | { kept: true }

/**
 * Best effort, and never throws.
 *
 * Called after the decision is committed and after any refund has already been made at Stripe.
 * A bounced email must not undo either, and must not leave the queue item sitting there looking
 * undecided — which is what throwing from here would do.
 */
export async function notifyRentDecision(
  bookingId: string,
  decision: RentDecision,
): Promise<void> {
  try {
    const [row] = await db
      .select({
        firstName: providers.firstName,
        email: providers.email,
        serviceName: services.name,
        startTime: bookings.startTime,
        reason: bookings.outcomeReason,
      })
      .from(bookings)
      .innerJoin(providers, eq(bookings.providerId, providers.id))
      .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
      .innerJoin(services, eq(providerServices.serviceId, services.id))
      .where(eq(bookings.id, bookingId))
      .limit(1)

    if (!row) return

    await sendEmail({
      to: row.email,
      ...rentalDecisionEmail({
        firstName: row.firstName,
        serviceName: row.serviceName,
        when: appointmentWhen(row.startTime),
        refunded: 'refunded' in decision ? decision.refunded : null,
        reason: row.reason,
        url: `${await appOrigin()}/app/charges`,
      }),
    })
  } catch (err) {
    console.error('[email] rental decision notice failed for booking', bookingId, err)
  }
}
