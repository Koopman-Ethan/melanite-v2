import 'server-only'

import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providers } from '@/lib/db/schema'

import { stripeGet, stripePost } from './client'

// Putting a card on file for rental fees.
//
// Collected through Stripe Checkout in `setup` mode — a hosted page, a redirect back, and a
// webhook — rather than with Stripe Elements in our own form. The same shape the membership
// subscription already uses, and the reason is the same: card details never reach this
// application, so there is nothing here to get PCI-wrong and no card field to accidentally log.
//
// Checkout in setup mode creates a SetupIntent rather than charging anything. What comes back on
// the session is the intent's id; the payment method hangs off the intent, and its brand and
// last four hang off the payment method. Hence two reads below. They are worth it: a provider
// about to be charged $130 should be able to see which card without a round trip to Stripe, and
// `chargeRentalFee` names the instrument it uses rather than trusting remote default state.

interface SetupIntentObject {
  id: string
  customer: string | null
  payment_method: string | null
  status: string
}

interface PaymentMethodObject {
  id: string
  /** `card`, or `link` when somebody paid through the Stripe Link wallet. */
  type?: string
  card?: {
    brand?: string
    last4?: string
    exp_month?: number
    exp_year?: number
  }
}

/**
 * Records the card a completed setup session produced.
 *
 * Called from the webhook, so it must be safe to run twice — Stripe retries until it gets a 2xx,
 * including after a success it never recorded. Every write here is an overwrite with the same
 * values, so a replay is harmless.
 *
 * Refuses an unfinished intent rather than storing a payment method that was never confirmed.
 */
export async function saveRentalCard(
  providerId: string,
  setupIntentId: string | null,
  customerId: string | null,
): Promise<{ saved: true } | { error: string }> {
  if (!setupIntentId) return { error: 'That checkout session had no setup intent.' }

  const intent = await stripeGet<SetupIntentObject>(`/setup_intents/${setupIntentId}`)

  if (intent.status !== 'succeeded') {
    return { error: `The card was not set up (${intent.status}).` }
  }
  if (!intent.payment_method) {
    return { error: 'That setup produced no payment method.' }
  }

  const customer = customerId ?? intent.customer
  if (!customer) {
    // Without a Customer there is nothing to charge the card against later. Stripe creates one
    // for a setup session, so this should not happen — and if it does, failing loudly is far
    // better than storing a payment method that cannot be used off-session.
    return { error: 'That setup produced no customer to bill.' }
  }

  const method = await stripeGet<PaymentMethodObject>(`/payment_methods/${intent.payment_method}`)

  // Also set as the Customer's default. Nothing here reads it — every charge names the payment
  // method explicitly — but a Stripe-side retry or an invoice created in the dashboard would,
  // and leaving it unset makes the Customer look half-configured to anyone looking at Stripe.
  await stripePost(`/customers/${customer}`, {
    'invoice_settings[default_payment_method]': intent.payment_method,
  })

  await db
    .update(providers)
    .set({
      stripeBillingCustomerId: customer,
      billingPaymentMethodId: intent.payment_method,
      // A non-card payment method has no brand or last four. The session now asks for a card
      // explicitly, so this should not happen — but if it does, record WHAT it is rather than
      // leaving every display column null, which reads identically to having no payment method
      // at all and is how a provider ends up stuck on a step they have already completed.
      billingCardBrand: method.card?.brand ?? method.type ?? null,
      billingCardLast4: method.card?.last4 ?? null,
      billingCardExpMonth: method.card?.exp_month ?? null,
      billingCardExpYear: method.card?.exp_year ?? null,
    })
    .where(eq(providers.id, providerId))

  // A NEW CARD CLEARS THE BACK-OFF, and without this the block on booking is a trap.
  //
  // A rental fee that declines is stamped on the booking and not retried for twenty hours, so a
  // dead card does not decline on every sweep and email the provider each time. Sensible on its
  // own. But unpaid rent also stops the provider booking again, and the message telling them so
  // says to update their card and that it will be tried again — so somebody who does exactly
  // that stays locked out for most of a day, with nothing they can do and no sign anything
  // changed. Ethan walked into it within a minute of adding the working card back.
  //
  // A fresh card is precisely the signal that retrying is worth it: the reason it failed has
  // just been addressed. Clearing the stamp puts those sessions back in front of the next
  // sweep, which runs on the next page load at the latest.
  //
  // The attempt count goes back to zero for the same reason. It exists to stop a dead card
  // being hammered forever, not to ration how many cards somebody may try.
  await db
    .update(bookings)
    .set({ rentChargeFailedAt: null, rentChargeError: null, rentChargeAttempts: 0 })
    .where(
      and(
        eq(bookings.providerId, providerId),
        isNotNull(bookings.rentChargeFailedAt),
        isNull(bookings.rentWaivedAt),
      ),
    )

  return { saved: true }
}

/**
 * Forgets the card on file.
 *
 * Detaches at Stripe as well as clearing the columns. Clearing only our side would leave a
 * payment method attached to a Customer that nothing references — invisible here and still
 * chargeable there, which is the wrong half of a deletion to skip.
 *
 * The provider cannot book afterwards: `createBooking` refuses without a card. That is the
 * intended consequence and the screen offering this says so.
 */
export async function forgetRentalCard(providerId: string): Promise<{ error?: string }> {
  const [provider] = await db
    .select({ paymentMethodId: providers.billingPaymentMethodId })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  if (provider?.paymentMethodId) {
    try {
      await stripePost(`/payment_methods/${provider.paymentMethodId}/detach`, {})
    } catch (err) {
      // A payment method already detached, or belonging to a deleted customer, throws here. The
      // local columns must still be cleared — otherwise the app goes on believing it can charge
      // a card Stripe has already forgotten.
      console.warn('[billing-card] detach failed, clearing locally anyway', err)
    }
  }

  await db
    .update(providers)
    .set({
      billingPaymentMethodId: null,
      billingCardBrand: null,
      billingCardLast4: null,
      billingCardExpMonth: null,
      billingCardExpYear: null,
    })
    .where(eq(providers.id, providerId))

  return {}
}
