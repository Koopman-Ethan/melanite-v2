'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { isOnboarding } from '@/lib/onboarding'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'

export interface StripeRedirect {
  url?: string
  error?: string
}

// Stripe Connect onboarding.
//
// This is what lets a provider be PAID. Bookings use destination charges, so without a
// connected account with payouts enabled there is nowhere for their share to go — the money
// would sit on the platform balance. It is the most consequential Stripe write in the app and
// the one most easily forgotten, because nothing visibly breaks until the first payout.
//
// The account is created once and reused. Creating a second one for a provider who already has
// one would orphan their payout history, which is why the id is stored the moment it exists,
// before the onboarding link is even generated.

async function origin(): Promise<string> {
  const h = await headers()
  return (
    process.env.APP_BASE_URL ??
    `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host') ?? 'localhost:3000'}`
  )
}

export async function startStripeOnboarding(): Promise<StripeRedirect> {
  const user = await requireProvider()

  const [provider] = await db
    .select({
      email: providers.email,
      firstName: providers.firstName,
      lastName: providers.lastName,
      stripeAccountId: providers.stripeAccountId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!provider) return { error: 'Account not found.' }

  const base = await origin()

  try {
    let accountId = provider.stripeAccountId

    if (!accountId) {
      const account = await stripePost<{ id: string }>(
        '/accounts',
        {
          type: 'express',
          country: 'US',
          email: provider.email,
          // v1's note, worth preserving: provider accounts have the TRANSFERS capability
          // only, not card_payments. Charges are made on the platform account and the
          // provider's share is transferred, which is why on_behalf_of is not used.
          capabilities: { transfers: { requested: true } },
          business_type: 'individual',
          individual: {
            email: provider.email,
            first_name: provider.firstName,
            last_name: provider.lastName,
          },
          metadata: { provider_id: user.id },
        },
        // One account per provider, forever. Without this key a retried request creates a
        // second account and their payout history splits in two.
        { idempotencyKey: `connect-account:${user.id}` },
      )

      accountId = account.id

      // Stored BEFORE the link is generated. If link creation fails after the account exists,
      // a retry must reuse it rather than create another.
      await db
        .update(providers)
        .set({ stripeAccountId: accountId })
        .where(eq(providers.id, user.id))
    }

    // Where Stripe sends them back to. A provider still in setup goes back to the SETUP step,
    // not to Account — landing them in the full app halfway through the flow, with their
    // progress still recorded as the previous step, is how someone gets stranded and gives up.
    const back = isOnboarding(user) ? '/onboarding/stripe' : '/app/account'

    // Deliberately no idempotency key: account links are single-use and expire in minutes, so
    // replaying a stale one for 24 hours would hand back a dead link.
    const link = await stripePost<{ url?: string }>('/account_links', {
      account: accountId,
      refresh_url: `${base}${back}?stripe=refresh`,
      return_url: `${base}${back}?stripe=return`,
      type: 'account_onboarding',
    })

    return link.url ? { url: link.url } : { error: 'Stripe did not return an onboarding link.' }
  } catch (err) {
    return {
      error: friendlyStripeError(err, 'Could not start Stripe onboarding. Try again shortly.'),
    }
  }
}

/** Stripe Express dashboard, for a provider who has already onboarded. */
export async function openStripeDashboard(): Promise<StripeRedirect> {
  const user = await requireProvider()

  const [provider] = await db
    .select({ stripeAccountId: providers.stripeAccountId })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!provider?.stripeAccountId) return { error: 'You haven’t connected Stripe yet.' }

  try {
    const login = await stripePost<{ url?: string }>(
      `/accounts/${provider.stripeAccountId}/login_links`,
      {},
    )
    return login.url ? { url: login.url } : { error: 'Stripe did not return a dashboard link.' }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not open your Stripe dashboard.') }
  }
}
