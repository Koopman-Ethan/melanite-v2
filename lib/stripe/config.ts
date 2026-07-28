import 'server-only'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

import { db } from '@/lib/db'
import { platformSettings } from '@/lib/db/schema'

/** Base URL for Stripe return trips.
 *
 *  `APP_BASE_URL` wins so production is not at the mercy of a forwarded header. Shared rather
 *  than duplicated per feature: a checkout that returns to the wrong host lands the provider on
 *  a login page with no explanation of what happened to their payment. */
export async function appOrigin(): Promise<string> {
  const h = await headers()
  return (
    process.env.APP_BASE_URL ??
    `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('host') ?? 'localhost:3000'}`
  )
}

// Stripe ids that differ between test and live.
//
// The imported data holds LIVE ids — the medical-director price, the platform account, seven
// Connect accounts, four billing customers. Test mode is a separate universe where none of
// those exist, so a test key pointed at imported data fails with "No such price".
//
// Rather than editing production rows to test a dev flow, the environment may override. Set
// the variable in .env.local for development; leave it unset in production and the value comes
// from platform_settings, which is where it belongs.

/** The medical-director subscription price.
 *
 *  `STRIPE_MD_PRICE_ID` wins when set. The mode of the price MUST match the mode of
 *  STRIPE_SECRET_KEY_WRITE — a live price with a test key, or the reverse, fails at checkout
 *  rather than at startup, which is a confusing place to find out. */
export async function medicalDirectorPriceId(): Promise<string | null> {
  const override = process.env.STRIPE_MD_PRICE_ID
  if (override && override.length > 0) return override

  const [settings] = await db
    .select({ priceId: platformSettings.medicalDirectorPriceId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return settings?.priceId ?? null
}

/** The Epicutis membership price.
 *
 *  Same shape as the director plan, and deliberately a SEPARATE lookup rather than a shared
 *  "get the price for plan X" helper — the two are configured independently and a provider can
 *  hold both at once, so nothing should encourage treating them as interchangeable. */
export async function epicutisPriceId(): Promise<string | null> {
  const override = process.env.STRIPE_EPICUTIS_PRICE_ID
  if (override && override.length > 0) return override

  const [settings] = await db
    .select({ priceId: platformSettings.epicutisPriceId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return settings?.priceId ?? null
}

/** Which plan a Stripe subscription or invoice belongs to.
 *
 *  Read from metadata written at checkout, because that is the only signal that survives every
 *  event type — a subscription event carries its price, an invoice event may not, and matching
 *  on price id alone breaks the day somebody changes the price in the dashboard.
 *
 *  Falls back to `medical_director` for anything unlabelled, which is what every subscription
 *  created before this existed looks like. Getting that fallback backwards would grant the
 *  booking gate to an Epicutis subscriber. */
export function planFromMetadata(metadata: Record<string, string> | null | undefined) {
  return metadata?.plan === 'epicutis' ? ('epicutis' as const) : ('medical_director' as const)
}

/** Warns when the write key and the price are in different Stripe modes.
 *
 *  This is the single most likely misconfiguration once both a live and a test key exist, and
 *  it surfaces as an opaque Stripe error at the worst moment. Checking it where the mismatch
 *  is visible costs nothing. */
export function modeMismatch(priceId: string | null): string | null {
  const key = process.env.STRIPE_SECRET_KEY_WRITE
  if (!key || !priceId) return null

  const keyIsLive = key.includes('_live_')
  // Stripe price ids carry no mode marker, so this can only be checked against what the
  // settings row was imported with — a live id is known, a test one is not distinguishable.
  const priceIsImportedLive = priceId === process.env.STRIPE_MD_PRICE_ID ? false : true

  if (keyIsLive && !priceIsImportedLive) {
    return 'Live Stripe key with an overridden (test) price id.'
  }
  if (!keyIsLive && priceIsImportedLive) {
    return 'Test Stripe key with the imported live price id — set STRIPE_MD_PRICE_ID to a test price.'
  }

  return null
}

/** True when Stripe is telling us the stored billing customer no longer exists.
 *
 *  It happens for real: a customer deleted in the dashboard, a database restored across Stripe
 *  modes, a migration that brought live ids into a test environment. Without recognising it,
 *  the provider gets "Could not start the subscription" forever and there is nothing they or
 *  Melanite can do from the app — the id is not editable anywhere.
 */
export function isMissingCustomerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no such customer/i.test(message)
}
