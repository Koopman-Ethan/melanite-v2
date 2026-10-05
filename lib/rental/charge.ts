import 'server-only'

import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, ledgerEntries, providerServices, providers, services } from '@/lib/db/schema'
import { toMoney } from '@/lib/money'
import { feeForService } from '@/lib/rental/schedule'
import { StripeApiError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'

// Charging a provider to use the laser.
//
// The rental model's money path. A provider reserves a slot and Melanite takes the rental fee for
// that service off the card they have on file — no split, no Connect, no client involved.
//
// EVERY REFUSAL HAPPENS BEFORE THE STRIPE CALL. That is the same rule `lib/stripe/fees.ts` follows
// and for the same reason: it makes the refusals testable for real, against real rows, without a
// network call. A booking that should not be charged never reaches the API.
//
// The ledger row is provider-paid, which the table already has a shape and a check constraint for:
// `payer = 'provider'` implies `provider_payout = 0 AND melanite_cut = gross_amount`. Room rental
// and membership write exactly this; a rental fee is a third instance of a proven pattern rather
// than a new one.

export type RentalChargeResult =
  /** Charged. `ledgerEntryId` is the row recording it. */
  | { charged: { amountCents: number; ledgerEntryId: string } }
  /** Deliberately not charged, for a reason worth showing somebody. Not an error. */
  | { skipped: string }
  /** Could not be charged and should be. */
  | { error: string }

/** What this booking costs the provider, before any decision about whether to take it.
 *
 *  Null when the service has no published fee — see `UNPRICED` in `lib/rental-fees.ts`. Null is
 *  "cannot be booked", never "free". */
export async function rentalFeeForBooking(bookingId: string): Promise<number | null> {
  const [row] = await db
    .select({ serviceName: services.name })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)

  return row ? await feeForService(row.serviceName) : null
}

/**
 * Takes the rental fee for one booking.
 *
 * Refuses rather than guesses: no booking, no card, a service with no published fee, a fee already
 * taken, or a house appointment. Booking laser time is not damaging to get wrong in the way
 * charging an absent client is, but charging a provider twice for one session is, and the guards
 * below are mostly about that.
 */
export async function chargeRentalFee(bookingId: string): Promise<RentalChargeResult> {
  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  const [booking] = await db
    .select({
      id: bookings.id,
      providerId: bookings.providerId,
      status: bookings.status,
      startTime: bookings.startTime,
      serviceId: providerServices.serviceId,
      serviceName: services.name,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment does not exist.' }

  // Charging one session twice is the failure this guards against — a retry, a double submit, or
  // a provider cancelling and rebooking the same slot. Keyed on the booking, like the fee guard in
  // `lib/stripe/fees.ts`.
  const [existing] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'booking'),
        eq(ledgerEntries.subjectId, booking.id),
        eq(ledgerEntries.source, 'rental_fee'),
        eq(ledgerEntries.entryType, 'purchase'),
      ),
    )
    .limit(1)

  if (existing) return { skipped: 'The rental fee for this session has already been charged.' }

  const [provider] = await db
    .select({
      firstName: providers.firstName,
      lastName: providers.lastName,
      revenueModel: providers.revenueModel,
      customerId: providers.stripeBillingCustomerId,
      paymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(eq(providers.id, booking.providerId))
    .limit(1)

  if (!provider) return { error: 'That appointment has no provider.' }

  // Melanite treating Melanite's own client. There is no rent to pay yourself, and a $0 ledger row
  // would only make "what does the laser earn" read low for no reason.
  if (provider.revenueModel === 'house') {
    return { skipped: "Melanite's own appointment — no rental fee." }
  }

  const amountCents = await feeForService(booking.serviceName)
  if (amountCents === null) {
    // The loud gap. A service with no published fee must not become a free session; it is a
    // question for Keoni, and until she answers it this booking cannot be billed.
    return {
      error: `${booking.serviceName} has no published rental fee yet, so it cannot be booked.`,
    }
  }

  if (!provider.customerId || !provider.paymentMethodId) {
    return {
      error: `${provider.firstName} ${provider.lastName} has no card on file for rental fees.`,
    }
  }

  let intentId: string
  try {
    const intent = await stripePost<{ id: string; status: string }>('/payment_intents', {
      amount: amountCents,
      currency: 'usd',
      customer: provider.customerId,
      payment_method: provider.paymentMethodId,
      // The provider is present — they are booking — but the charge is a side effect of the
      // booking rather than a checkout they are completing, so there is nobody watching for a 3DS
      // challenge. A card that insists on one declines, which is the correct outcome.
      off_session: true,
      confirm: true,
      description: `Laser rental — ${booking.serviceName}`,
      metadata: {
        type: 'rental_fee',
        booking_id: booking.id,
        provider_id: booking.providerId,
      },
    },
    // Keyed on the booking, so a double submit or a retry cannot take the fee twice even if it
    // races the ledger check above. One session, one charge, enforced at Stripe as well as here.
    { idempotencyKey: `rental-fee:${booking.id}` })
    intentId = intent.id
  } catch (err) {
    if (err instanceof StripeApiError) {
      return { error: `The card was declined: ${err.message}` }
    }
    throw err
  }

  const [entry] = await db
    .insert(ledgerEntries)
    .values({
      source: 'rental_fee',
      payer: 'provider',
      entryType: 'purchase',
      subjectType: 'booking',
      subjectId: booking.id,
      providerId: booking.providerId,
      serviceId: booking.serviceId,
      grossAmount: toMoney(amountCents),
      tipAmount: '0.00',
      // Provider-paid, so there is no split. The check constraint on `ledgerEntries` enforces
      // this pairing; writing anything else here fails the insert rather than quietly recording a
      // payout to somebody who is owed nothing.
      providerPayout: '0.00',
      melaniteCut: toMoney(amountCents),
      paymentMethod: 'stripe',
      stripePaymentIntentId: intentId,
      // Nothing is owed onward, so it is settled the moment it is recorded — the same reasoning
      // room rental and membership already use.
      payoutStatus: 'paid',
    })
    .returning({ id: ledgerEntries.id })

  return { charged: { amountCents, ledgerEntryId: entry.id } }
}

/**
 * Rental bookings nobody was billed for.
 *
 * The booking path takes the slot before it takes the money, because the exclusion constraint can
 * only arbitrate a shared laser once a row exists. That leaves one window: a crash between the
 * insert and the charge. It cannot be closed without a transaction the neon-http driver does not
 * have, so it is detected instead.
 *
 * Re-charging one of these is safe. `chargeRentalFee` is keyed on the booking id at Stripe as well
 * as here, so a booking whose charge actually succeeded before the crash gets its ledger row
 * written rather than a second payment taken.
 *
 * Excludes bookings covered by a pack session, which are paid for and have no ledger row by
 * design, and Melanite's own appointments, which owe no rent.
 */
export async function unchargedRentalBookings(): Promise<
  { bookingId: string; providerId: string; serviceName: string; startTime: Date }[]
> {
  const rows = await db.execute<{
    id: string
    provider_id: string
    service_name: string
    start_time: string
  }>(sql`
    SELECT b.id, b.provider_id, s.name AS service_name, b.start_time
      FROM bookings b
      JOIN provider_services ps ON ps.id = b.provider_service_id
      JOIN services s           ON s.id = ps.service_id
      JOIN providers p          ON p.id = b.provider_id
     WHERE b.payment_source = 'rental'
       AND p.revenue_model <> 'house'
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries le
          WHERE le.subject_type = 'booking' AND le.subject_id = b.id
            AND le.source = 'rental_fee' AND le.entry_type = 'purchase'
       )
       AND NOT EXISTS (
         SELECT 1 FROM provider_pack_redemptions r
          WHERE r.booking_id = b.id AND r.voided_at IS NULL
       )
     ORDER BY b.start_time
  `)

  return (rows.rows ?? []).map((r) => ({
    bookingId: r.id,
    providerId: r.provider_id,
    serviceName: r.service_name,
    startTime: new Date(r.start_time),
  }))
}

/**
 * Gives the rental fee back.
 *
 * Keoni's rule is that a provider does not owe the fee when their client does not turn up. The fee
 * is taken when the slot is reserved and a no-show is only known afterwards, so honouring that
 * rule means REFUNDING rather than skipping — there is no moment at which the charge could have
 * been avoided.
 *
 * Recorded as a `refund` row rather than by deleting or amending the purchase, because the ledger
 * is append-only and "this was charged and then returned" is a different fact from "this was never
 * charged".
 */
export async function refundRentalFee(bookingId: string): Promise<RentalChargeResult> {
  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  const [purchase] = await db
    .select({
      id: ledgerEntries.id,
      providerId: ledgerEntries.providerId,
      serviceId: ledgerEntries.serviceId,
      grossAmount: ledgerEntries.grossAmount,
      intentId: ledgerEntries.stripePaymentIntentId,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'booking'),
        eq(ledgerEntries.subjectId, bookingId),
        eq(ledgerEntries.source, 'rental_fee'),
        eq(ledgerEntries.entryType, 'purchase'),
      ),
    )
    .limit(1)

  if (!purchase) return { skipped: 'No rental fee was charged for this session.' }

  const [already] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'booking'),
        eq(ledgerEntries.subjectId, bookingId),
        eq(ledgerEntries.source, 'rental_fee'),
        eq(ledgerEntries.entryType, 'refund'),
      ),
    )
    .limit(1)

  if (already) return { skipped: 'The rental fee for this session has already been refunded.' }

  if (!purchase.intentId) {
    return { error: 'That rental fee has no payment to refund against.' }
  }

  try {
    await stripePost<{ id: string }>(
      '/refunds',
      {
        payment_intent: purchase.intentId,
        metadata: { type: 'rental_fee_refund', booking_id: bookingId },
      },
      { idempotencyKey: `rental-refund:${bookingId}` },
    )
  } catch (err) {
    if (err instanceof StripeApiError) {
      return { error: `The refund was refused: ${err.message}` }
    }
    throw err
  }

  const amountCents = Math.round(Number(purchase.grossAmount) * 100)

  const [entry] = await db
    .insert(ledgerEntries)
    .values({
      source: 'rental_fee',
      payer: 'provider',
      entryType: 'refund',
      subjectType: 'booking',
      subjectId: bookingId,
      providerId: purchase.providerId,
      serviceId: purchase.serviceId,
      // Negative, so that summing the column gives the truth without every report having to know
      // which entry types to subtract. The check constraint still holds: nothing was paid out, and
      // Melanite's cut moved by the whole amount.
      grossAmount: toMoney(-amountCents),
      tipAmount: '0.00',
      providerPayout: '0.00',
      melaniteCut: toMoney(-amountCents),
      paymentMethod: 'stripe',
      stripePaymentIntentId: purchase.intentId,
      payoutStatus: 'paid',
    })
    .returning({ id: ledgerEntries.id })

  return { charged: { amountCents: -amountCents, ledgerEntryId: entry.id } }
}
