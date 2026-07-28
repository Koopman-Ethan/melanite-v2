'use server'

import { and, eq } from 'drizzle-orm'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { memberships, providers } from '@/lib/db/schema'
import { isOnboarding } from '@/lib/onboarding'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'
import {
  appOrigin,
  epicutisPriceId,
  isMissingCustomerError,
  medicalDirectorPriceId,
  modeMismatch,
} from '@/lib/stripe/config'

export interface StripeRedirect {
  url?: string
  error?: string
}

// Subscription actions. Both create a Stripe-hosted session and hand the provider off, so no
// card details ever reach this app — that keeps it out of PCI scope entirely, and is what v1
// does too.
//
// Neither of these grants access. Paying does not set medical_director_status; the
// invoice.payment_succeeded webhook does. That split is deliberate: a checkout that completes
// but whose payment later fails must not have already opened the booking gate.


/** Opens a subscription checkout, recovering from a stale billing customer.
 *
 *  Reusing the stored customer is what keeps both subscriptions on one Stripe record so the
 *  billing portal can manage them together. But a stored id that Stripe no longer recognises
 *  turns the button into a dead end — nothing in the app can edit it — so a "no such customer"
 *  failure clears it and retries as a fresh customer. The webhook writes the new id back.
 */
async function subscriptionCheckout(
  providerId: string,
  email: string | undefined,
  storedCustomerId: string | null | undefined,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<StripeRedirect> {
  const open = async (customer: string | null, key: string) =>
    stripePost<{ url?: string }>(
      '/checkout/sessions',
      { ...payload, ...(customer ? { customer } : { customer_email: email }) },
      { idempotencyKey: key },
    )

  try {
    const session = await open(storedCustomerId ?? null, idempotencyKey)
    return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
  } catch (err) {
    if (!storedCustomerId || !isMissingCustomerError(err)) {
      return { error: friendlyStripeError(err, 'Could not start the subscription.') }
    }

    console.warn(`[stripe] clearing unknown billing customer ${storedCustomerId} for ${providerId}`)
    await db
      .update(providers)
      .set({ stripeBillingCustomerId: null })
      .where(eq(providers.id, providerId))

    try {
      // A different key: the first attempt is cached against the old customer, and replaying it
      // would hand back the same failure.
      const session = await open(null, `${idempotencyKey}:recustomer`)
      return session.url
        ? { url: session.url }
        : { error: 'Stripe did not return a checkout link.' }
    } catch (retryErr) {
      return { error: friendlyStripeError(retryErr, 'Could not start the subscription.') }
    }
  }
}

export async function startSubscription(): Promise<StripeRedirect> {
  const user = await requireProvider()

  if (user.medicalDirectorStatus === 'active' || user.medicalDirectorStatus === 'past_due') {
    return { error: 'You already have a medical director subscription.' }
  }

  const priceId = await medicalDirectorPriceId()
  if (!priceId) {
    return { error: 'The medical director plan isn’t configured yet. Contact Melanite.' }
  }

  // A test key with a live price (or the reverse) fails at Stripe with an opaque "No such
  // price", which is a poor place to discover a config mistake. Say it here instead.
  const mismatch = modeMismatch(priceId)
  if (mismatch) console.warn(`[membership] ${mismatch}`)

  const [provider] = await db
    .select({
      email: providers.email,
      stripeBillingCustomerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await appOrigin()

  // A provider still in setup returns to the medical-director step, not to Membership. Their
  // remaining steps are there, and Membership shows nothing they can act on yet.
  const back = isOnboarding(user) ? '/onboarding/director' : '/app/membership'

  try {
    const session = await stripePost<{ url?: string }>(
      '/checkout/sessions',
      {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}${back}?subscribed=1`,
        cancel_url: `${base}${back}`,
        // The webhook has no other way to know whose subscription this is. Set on BOTH the
        // session and the subscription, because checkout.session.completed and
        // invoice.payment_succeeded read from different objects.
        // `plan` is what the webhooks route on. Without it every subscription looks like the
        // director plan, which is the default — correct for anything created before Epicutis
        // existed, and wrong for anything created after.
        metadata: { provider_id: user.id, plan: 'medical_director' },
        subscription_data: {
          metadata: { provider_id: user.id, plan: 'medical_director' },
        },
        ...(provider?.stripeBillingCustomerId
          ? { customer: provider.stripeBillingCustomerId }
          : { customer_email: provider?.email }),
      },
      {
        // Keyed on the provider, so a double-click or a retried request reuses the same
        // session rather than starting a second subscription. Stripe replays the original
        // response for 24 hours, which is far longer than anyone spends deciding.
        idempotencyKey: `md-subscribe:${user.id}`,
      },
    )

    return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not start checkout. Try again shortly.') }
  }
}

export async function openBillingPortal(): Promise<StripeRedirect> {
  const user = await requireProvider()

  const [provider] = await db
    .select({ stripeBillingCustomerId: providers.stripeBillingCustomerId })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!provider?.stripeBillingCustomerId) {
    return { error: 'No billing account on file yet.' }
  }

  const base = await appOrigin()

  try {
    // No idempotency key: a portal session moves no money and expires quickly, so reusing a
    // stale one for 24 hours would be worse than making a fresh one each time.
    const session = await stripePost<{ url?: string }>('/billing_portal/sessions', {
      customer: provider.stripeBillingCustomerId,
      return_url: `${base}/app/membership`,
    })

    return session.url ? { url: session.url } : { error: 'Stripe did not return a portal link.' }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not open the billing portal. Try again shortly.') }
  }
}

/**
 * The Epicutis membership — $95/month for monthly content, client inquiries and wholesale
 * pricing.
 *
 * Unlocks NOTHING in this app, and that is the important part. It sits beside the medical
 * director plan on the same page and is charged the same way, so the temptation is to treat
 * them as two of a kind; they are not. One is a booking gate and the other is a benefit
 * delivered entirely outside this system. The webhooks tell them apart by the `plan` metadata
 * set below — before that existed, paying for this would have granted medical direction and
 * cancelling it would have revoked the ability to book.
 */
export async function startEpicutisSubscription(): Promise<StripeRedirect> {
  const user = await requireProvider()

  // Any active provider may subscribe, including someone still waiting on document approval:
  // content and wholesale access has nothing to do with whether they can operate the laser yet.
  const [existing] = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.providerId, user.id), eq(memberships.plan, 'epicutis')))
    .limit(1)

  if (existing && (existing.status === 'active' || existing.status === 'past_due')) {
    return { error: 'You already have an Epicutis membership.' }
  }

  const priceId = await epicutisPriceId()
  if (!priceId) {
    return { error: 'The Epicutis membership isn’t configured yet. Contact Melanite.' }
  }

  const mismatch = modeMismatch(priceId)
  if (mismatch) console.warn(`[epicutis] ${mismatch}`)

  const [provider] = await db
    .select({
      email: providers.email,
      stripeBillingCustomerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await appOrigin()

  // Reuses the billing customer the director plan created, so both subscriptions sit on one
  // Stripe record and the billing portal manages them together.
  return subscriptionCheckout(
    user.id,
    provider?.email,
    provider?.stripeBillingCustomerId,
    {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/app/membership?epicutis=1`,
      cancel_url: `${base}/app/membership`,
      metadata: { provider_id: user.id, plan: 'epicutis' },
      subscription_data: { metadata: { provider_id: user.id, plan: 'epicutis' } },
    },
    `epicutis-subscribe:${user.id}`,
  )
}
