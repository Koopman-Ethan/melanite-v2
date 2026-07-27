'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { platformSettings, providers } from '@/lib/db/schema'

export interface StripeRedirect {
  url?: string
  error?: string
}

// Subscription actions. Both create a Stripe session and hand the provider off, so no card
// details ever reach this app.
//
// NOT YET LIVE. These need a Stripe key that can WRITE — the configured
// STRIPE_SECRET_KEY is a restricted read-only key, used for reading the account during the
// migration. Wiring a write key is a deliberate step, not something to slip in beside a
// read-only one, so these fail with an explicit message rather than half-working.
//
// To enable: add STRIPE_SECRET_KEY_WRITE (a live secret or a restricted key with write on
// Checkout Sessions, Billing Portal Sessions and Customers), then remove the guard below.
// The subscription itself is then driven by Stripe webhooks, which also are not ported yet —
// v1 handled checkout.session.completed, invoice.payment_succeeded, invoice.payment_failed
// and customer.subscription.deleted, and those must land before a real subscription starts,
// or medical_director_status will never update and booking will stay blocked.

const STRIPE_API = 'https://api.stripe.com/v1'

function writeKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY_WRITE
  return key && key.length > 0 ? key : null
}

const NOT_CONFIGURED =
  'Subscription checkout isn’t connected yet. Contact Melanite and they’ll get you set up.'

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

  const [settings] = await db
    .select({ priceId: platformSettings.medicalDirectorPriceId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  if (!settings?.priceId) {
    return { error: 'The medical director plan isn’t configured yet. Contact Melanite.' }
  }

  const key = writeKey()
  if (!key) return { error: NOT_CONFIGURED }

  const [provider] = await db
    .select({
      email: providers.email,
      stripeBillingCustomerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await origin()
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': settings.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${base}/app/membership?subscribed=1`,
    cancel_url: `${base}/app/membership`,
    // The webhook needs to know whose subscription this is; the session is the only place to
    // carry it, and v1 does the same.
    'subscription_data[metadata][provider_id]': user.id,
    'metadata[provider_id]': user.id,
  })

  if (provider?.stripeBillingCustomerId) body.set('customer', provider.stripeBillingCustomerId)
  else if (provider?.email) body.set('customer_email', provider.email)

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    console.error('[membership] checkout session failed', await res.text())
    return { error: 'Could not start checkout. Try again shortly.' }
  }

  const session = (await res.json()) as { url?: string }
  return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
}

export async function openBillingPortal(): Promise<StripeRedirect> {
  const user = await requireProvider()

  const key = writeKey()
  if (!key) return { error: NOT_CONFIGURED }

  const [provider] = await db
    .select({ stripeBillingCustomerId: providers.stripeBillingCustomerId })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!provider?.stripeBillingCustomerId) {
    return { error: 'No billing account on file yet.' }
  }

  const base = await origin()
  const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: provider.stripeBillingCustomerId,
      return_url: `${base}/app/membership`,
    }),
  })

  if (!res.ok) {
    console.error('[membership] billing portal failed', await res.text())
    return { error: 'Could not open the billing portal. Try again shortly.' }
  }

  const session = (await res.json()) as { url?: string }
  return session.url ? { url: session.url } : { error: 'Stripe did not return a portal link.' }
}
