'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'
import { medicalDirectorPriceId, modeMismatch } from '@/lib/stripe/config'

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

async function origin(): Promise<string> {
  const h = await headers()
  return (
    process.env.APP_BASE_URL ??
    `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host') ?? 'localhost:3000'}`
  )
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

  const base = await origin()

  try {
    const session = await stripePost<{ url?: string }>(
      '/checkout/sessions',
      {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}/app/membership?subscribed=1`,
        cancel_url: `${base}/app/membership`,
        // The webhook has no other way to know whose subscription this is. Set on BOTH the
        // session and the subscription, because checkout.session.completed and
        // invoice.payment_succeeded read from different objects.
        metadata: { provider_id: user.id },
        subscription_data: { metadata: { provider_id: user.id } },
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

  const base = await origin()

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
