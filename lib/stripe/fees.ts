import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getClientCard } from '@/lib/db/queries/checkout'
import {
  bookings,
  ledgerEntries,
  platformSettings,
  providerServices,
  providers,
} from '@/lib/db/schema'
import { feeChargedEmail, sendEmail } from '@/lib/email'
import { splitFee, toCents, toMoney } from '@/lib/money'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'

// No-show and late-cancellation fees.
//
// v1 never charged either — "no-show charges are deferred to Phase 3 per locked decision" — and
// could not have, because it saved no card. The whole point of collecting one at checkout is
// this file.
//
// The fee is split EVENLY between Melanite and the provider, which is a different policy from
// the service split and lives in its own setting. A missed appointment costs the provider their
// chair time and costs Melanite the laser slot; neither absorbs it alone.

export type FeeKind = 'no_show_fee' | 'late_cancellation_fee'

export interface FeeResult {
  charged?: boolean
  amount?: string
  error?: string
  /** Set when there was simply nothing to charge — not an error the caller should shout about. */
  skipped?: string
}

export interface FeePolicy {
  noShowPct: number
  cancellationAmount: number
  lateHours: number
  providerSharePct: number
}

async function feePolicy(): Promise<FeePolicy> {
  const [row] = await db
    .select({
      noShowPct: platformSettings.noShowFeePctOfPrice,
      cancellationAmount: platformSettings.cancellationFeeAmount,
      lateHours: platformSettings.lateCancellationHours,
      providerSharePct: platformSettings.feeProviderSharePct,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return {
    noShowPct: Number(row?.noShowPct ?? 0.5),
    cancellationAmount: Number(row?.cancellationAmount ?? 50),
    lateHours: Number(row?.lateHours ?? 24),
    providerSharePct: Number(row?.providerSharePct ?? 0.5),
  }
}

/** What a fee would be, without charging it — for showing the provider before they commit. */
export async function quoteFee(
  bookingId: string,
  kind: FeeKind,
): Promise<{ amount: string; providerShare: string; melaniteShare: string } | null> {
  const policy = await feePolicy()

  const [booking] = await db
    .select({ price: bookings.price, paymentSource: bookings.paymentSource })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return null

  const amountCents = feeCents(kind, booking.price, policy)
  if (amountCents <= 0) return null

  const { providerPayoutCents, melaniteCutCents } = splitFee({
    amountCents,
    providerSharePct: policy.providerSharePct,
  })

  return {
    amount: toMoney(amountCents),
    providerShare: toMoney(providerPayoutCents),
    melaniteShare: toMoney(melaniteCutCents),
  }
}

/** The amount, before any split. Exported so it can be tested without a Stripe call —
 *  it is the number that ends up on somebody's card statement. */
export function feeCents(kind: FeeKind, price: string, policy: FeePolicy): number {
  return kind === 'no_show_fee'
    ? Math.round(toCents(price) * policy.noShowPct)
    : // A late cancellation is a flat amount, not a proportion: the cost is the empty slot,
      // which is the same whatever was booked into it.
      Math.round(policy.cancellationAmount * 100)
}

/** Charges the card on file, off-session.
 *
 *  Refuses rather than guesses in every ambiguous case: no card, no consent, a comped or
 *  package-redeemed booking with no price to work from, a fee already charged. Taking money
 *  from someone who is not present is the single most damaging thing this app can get wrong,
 *  so every path that is not clearly correct declines and says why.
 */
export async function chargeBookingFee(bookingId: string, kind: FeeKind): Promise<FeeResult> {
  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  const [booking] = await db
    .select({
      id: bookings.id,
      providerId: bookings.providerId,
      clientId: bookings.clientId,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      startTime: bookings.startTime,
      price: bookings.price,
      paymentSource: bookings.paymentSource,
      providerServiceId: bookings.providerServiceId,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment does not exist.' }
  if (!booking.clientId) {
    return { skipped: 'No client record on this appointment, so there is no card to charge.' }
  }

  // Charging the same booking twice is the failure this guards against — a provider marking
  // no-show, undoing it, and marking it again should not bill the client twice.
  const [existing] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.subjectType, 'booking'),
        eq(ledgerEntries.subjectId, booking.id),
        inArray(ledgerEntries.entryType, ['no_show_fee', 'late_cancellation_fee']),
      ),
    )
    .limit(1)

  if (existing) return { skipped: 'A fee has already been charged for this appointment.' }

  const card = await getClientCard(booking.clientId)
  if (!card?.defaultPaymentMethodId || !card.stripeCustomerId) {
    return recordFailure(booking.id, `${booking.clientName} has no card on file.`)
  }
  if (!card.consentAt) {
    // A card can exist without consent if it was attached by some other route. Stripe would
    // accept the charge; we should not.
    return recordFailure(
      booking.id,
      `${booking.clientName} did not authorise charges to their card.`,
    )
  }

  const policy = await feePolicy()
  const amountCents = feeCents(kind, booking.price, policy)
  if (amountCents <= 0) {
    return { skipped: 'This appointment has no price to base a fee on.' }
  }

  const [provider] = await db
    .select({
      stripeAccountId: providers.stripeAccountId,
      firstName: providers.firstName,
      lastName: providers.lastName,
    })
    .from(providers)
    .where(eq(providers.id, booking.providerId))
    .limit(1)

  const { providerPayoutCents: providerCents, melaniteCutCents: melaniteCents } = splitFee({
    amountCents,
    providerSharePct: policy.providerSharePct,
  })

  const [svc] = await db
    .select({ serviceId: providerServices.serviceId })
    .from(providerServices)
    .where(eq(providerServices.id, booking.providerServiceId))
    .limit(1)

  let intentId: string
  try {
    const intent = await stripePost<{ id: string; status: string }>(
      '/payment_intents',
      {
        amount: amountCents,
        currency: 'usd',
        customer: card.stripeCustomerId,
        payment_method: card.defaultPaymentMethodId,
        // The client is not here to complete a 3DS challenge. `off_session` tells Stripe to
        // use the mandate from the original payment; a card that insists on authentication
        // declines, and that is the correct outcome rather than a silent partial state.
        off_session: true,
        confirm: true,
        // Same destination-charge shape as the original payment, so the provider's half
        // arrives the same way their service revenue does.
        ...(provider?.stripeAccountId
          ? {
              transfer_data: { destination: provider.stripeAccountId },
              application_fee_amount: melaniteCents,
            }
          : {}),
        description:
          kind === 'no_show_fee'
            ? 'Missed appointment fee'
            : 'Late cancellation fee',
        metadata: {
          // NOT 'booking_payment' — this must not route to the handler that records a service
          // purchase and marks the checkout link paid.
          type: kind,
          booking_id: booking.id,
          client_id: booking.clientId,
          provider_id: booking.providerId,
        },
      },
      { idempotencyKey: `${kind}:${booking.id}` },
    )
    intentId = intent.id
  } catch (err) {
    // The provider gets a message; the queue gets a row. Without the second, a declined card is
    // a toast that disappears and a fee nobody ever collects.
    const reason = friendlyStripeError(err, 'The card was declined.')
    const failed = await recordFailure(booking.id, reason)
    return { error: failed.skipped }
  }

  // Written here rather than waiting for the webhook: this call is synchronous and already
  // knows the outcome, and the provider clicking the button deserves an answer now. The
  // webhook's replay guard is the unique index on (payment_intent, non-refund entry type).
  await db.insert(ledgerEntries).values({
    source: 'booking',
    payer: 'client',
    entryType: kind,
    subjectType: 'booking',
    subjectId: booking.id,
    providerId: booking.providerId,
    clientId: booking.clientId,
    serviceId: svc?.serviceId ?? null,
    grossAmount: toMoney(amountCents),
    tipAmount: '0.00',
    providerPayout: toMoney(providerCents),
    melaniteCut: toMoney(melaniteCents),
    paymentMethod: 'stripe',
    stripePaymentIntentId: intentId,
    payoutStatus: provider?.stripeAccountId ? 'pending' : 'paid',
    note: `${kind === 'no_show_fee' ? 'No-show fee' : 'Late cancellation fee'}, ${describeMethod(card)}`,
  })

  // Told, not discovered on a statement. They agreed to the fee, not to silence about it.
  // A send failure must never undo a charge that already went through.
  if (booking.clientEmail) {
    try {
      await sendEmail({
        to: booking.clientEmail,
        ...feeChargedEmail({
          clientName: booking.clientName,
          providerName: `${provider?.firstName ?? 'your provider'} ${provider?.lastName ?? ''}`.trim(),
          reason: kind,
          amount: `$${toMoney(amountCents)}`,
          when: booking.startTime.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            timeZone: 'America/Denver',
          }),
        }),
      })
    } catch (err) {
      console.error('[email] fee notice failed for booking', booking.id, err)
    }
  }

  // A successful charge clears any earlier failure, so a retry that works removes the item from
  // the queue rather than leaving a resolved problem sitting in it.
  await db
    .update(bookings)
    .set({ feeChargeFailedAt: null, feeChargeError: null })
    .where(eq(bookings.id, booking.id))

  return { charged: true, amount: toMoney(amountCents) }
}

/** Stamps the booking so the failure surfaces in the admin queue. */
async function recordFailure(bookingId: string, reason: string): Promise<FeeResult> {
  await db
    .update(bookings)
    .set({ feeChargeFailedAt: new Date(), feeChargeError: reason })
    .where(eq(bookings.id, bookingId))

  return { skipped: reason }
}

/** How to name the saved payment method in a ledger note.
 *
 *  Not every saved method is a card: Stripe Link carries an email and no card object at all, so
 *  brand-and-last-four formatting produces "•••• ????" and describes nothing. */
function describeMethod(card: {
  paymentMethodType: string | null
  cardBrand: string | null
  cardLast4: string | null
}): string {
  if (card.cardBrand && card.cardLast4) return `${card.cardBrand} ••••${card.cardLast4}`
  if (card.paymentMethodType === 'link') return 'Stripe Link'
  return card.paymentMethodType ?? 'saved payment method'
}
