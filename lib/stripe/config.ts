import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { platformSettings } from '@/lib/db/schema'

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
