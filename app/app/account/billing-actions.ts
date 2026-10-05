'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { isOnboarding } from '@/lib/onboarding'
import { RENTAL_TERMS_VERSION } from '@/lib/rental-terms'
import { liveScheduleVersion } from '@/lib/rental/schedule'
import { forgetRentalCard } from '@/lib/stripe/billing-card'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'
import { isMissingCustomerError } from '@/lib/stripe/config'
import { appOrigin } from '@/lib/stripe/config'

// The card Melanite charges for laser time, and the terms that go with it.
//
// This replaces Stripe Connect in onboarding. Connect existed to pay money OUT to a provider,
// which Melanite no longer does — the provider bills their own clients. What it needs instead is
// a card it can charge when they reserve the laser, which is the opposite direction and a much
// smaller thing to ask for: no SSN, no bank details, no identity verification.

export interface BillingRedirect {
  url?: string
  error?: string
}

/**
 * Opens Stripe Checkout in setup mode, to put a card on file.
 *
 * Hosted rather than an Elements form of our own, so card details never reach this application.
 * The card is recorded by the webhook, not on the way back — a provider who closes the tab after
 * paying attention to the Stripe page still ends up with a card on file.
 */
export async function startRentalCardSetup(): Promise<BillingRedirect> {
  const user = await requireProvider()

  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  const [provider] = await db
    .select({
      email: providers.email,
      customerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await appOrigin()
  // A provider still in setup comes back to the step they left, not to the account page — their
  // remaining steps are there and the account page would strand them mid-flow.
  const back = isOnboarding(user) ? '/onboarding/billing' : '/app/account'

  // NOT keyed on the provider alone. A card setup is something somebody may legitimately do
  // twice — a declined card, then a different one — and a 24-hour idempotent replay would hand
  // them back the session for the card that failed.
  const key = `rental-card:${user.id}:${Date.now()}`

  const open = (customer: string | null, idempotencyKey: string) =>
    stripePost<{ url?: string }>(
      '/checkout/sessions',
      {
        mode: 'setup',
        success_url: `${base}${back}?card=saved`,
        cancel_url: `${base}${back}`,
        // The webhook has no other way to know whose card this is.
        metadata: { provider_id: user.id, purpose: 'rental_card' },
        // Reuse the Customer if one exists — a provider who already pays for medical direction
        // should not end up with two Customers, which is how a card gets attached to the one
        // nothing charges.
        ...(customer
          ? { customer }
          : { customer_creation: 'always', customer_email: provider?.email }),
      },
      { idempotencyKey },
    )

  try {
    const session = await open(provider?.customerId ?? null, key)
    return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
  } catch (err) {
    // A stored customer Stripe has never heard of. `isMissingCustomerError` was written for
    // exactly this and the membership flow already recovers from it: a customer deleted in the
    // dashboard, or a database restored across Stripe modes — which is what the nightly copy of
    // production does to dev every morning, bringing live cus_ ids into a test account.
    //
    // Without this the provider is stuck forever on "Could not open Stripe", and the id is not
    // editable from anywhere in the app, so there is nothing they or Melanite can do about it.
    if (!provider?.customerId || !isMissingCustomerError(err)) {
      return { error: friendlyStripeError(err, 'Could not open Stripe. Try again shortly.') }
    }

    console.warn(
      `[stripe] clearing unknown billing customer ${provider.customerId} for ${user.id}`,
    )
    await db
      .update(providers)
      .set({ stripeBillingCustomerId: null })
      .where(eq(providers.id, user.id))

    try {
      // A different key. Stripe caches the response to an idempotent request even when it
      // failed, so replaying the original would hand back the same error.
      return await open(null, `${key}:recustomer`).then((session) =>
        session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' },
      )
    } catch (retryErr) {
      return { error: friendlyStripeError(retryErr, 'Could not open Stripe. Try again shortly.') }
    }
  }
}

/** Records that this provider accepted the rental terms AND the fee schedule as they currently
 *  stand.
 *
 *  Both stamped together, because they are accepted together on one screen. Recording only the
 *  prose version would leave a provider permanently unable to book after a price change, since
 *  the schedule half of the gate would never close. */
export async function acceptRentalTerms(): Promise<{ error?: string }> {
  const user = await requireProvider()
  const scheduleVersion = await liveScheduleVersion()

  await db
    .update(providers)
    .set({
      rentalTermsAckAt: new Date(),
      rentalTermsVersion: RENTAL_TERMS_VERSION,
      rentalScheduleVersion: scheduleVersion,
    })
    .where(eq(providers.id, user.id))

  revalidatePath('/app/account')
  revalidatePath('/app/book')
  revalidatePath('/onboarding/billing')
  return {}
}

/** Removes the card on file. The provider cannot book afterwards, and the screen says so. */
export async function removeRentalCard(): Promise<{ error?: string }> {
  const user = await requireProvider()
  const result = await forgetRentalCard(user.id)
  revalidatePath('/app/account')
  return result
}
