import '../envConfig'

import { eq, sql } from 'drizzle-orm'

import { providers } from '@/lib/db/schema'
import { RENTAL_TERMS_VERSION } from '@/lib/rental-terms'
import { liveScheduleVersion } from '@/lib/rental/schedule'
import { stripeGet, stripePost } from '@/lib/stripe/client'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// Gives dev providers a test card and an accepted set of rental terms.
//
//   npm run dev:rental-ready
//   npm run dev:rental-ready -- --check
//
// WHY THIS EXISTS
//
// Under the rental model a provider cannot book without a card on file and without having
// accepted the current terms and fee schedule. Both are correct, and both are acquired through
// a Stripe Checkout redirect and a webhook — which is fine for a real provider and a poor way
// to get a dev environment into a state where anybody can test a booking.
//
// The same reasoning as `dev-connect-accounts.ts`, which creates test Connect accounts for the
// same reason: the repair is necessary, and a remembered one is not repeatable. It is also the
// same reason `refresh-dev.ts` exists at all — the nightly copy of production brings back
// providers with no card, because production providers will not have one until cutover.
//
// NEVER AGAINST PRODUCTION, and guarded twice. `requireEnv` refuses anything but dev, and the
// Stripe key is checked for `_test_` before a single call is made — this attaches a payment
// method and marks providers as chargeable, and doing that to a real person with a real card
// is not a mistake that can be undone by re-running something.
//
// WHAT IT DOES NOT PROVE. The real card path is Checkout in setup mode plus a webhook, and
// this goes round both. To exercise that, use the Add a card button with the Stripe CLI
// forwarding events — see docs/cutover.md. This is for getting to the part you wanted to test.

/** Stripe's test Visa, as a TOKEN rather than a card number.
 *
 *  Posting `4242…` directly is refused unless the account has raw-card-data access turned on,
 *  which it should not have and does not. A token produces a real PaymentMethod per provider
 *  without this script ever handling a card number — and unlike the shared `pm_card_visa`
 *  handle, a token can be exchanged more than once, so every provider gets their own. */
const TEST_CARD_TOKEN = 'tok_visa'

/** Does this object exist in the Stripe account the write key points at?
 *
 *  Anything other than a clean read is treated as "no". In a dev fixture the cost of guessing
 *  wrong is one spare test customer; the cost of not checking is a run that fails with a
 *  message about permissions when the real cause is a live id in a test account. */
async function stripeHas(path: string): Promise<boolean> {
  try {
    await stripeGet(path)
    return true
  } catch {
    return false
  }
}

interface Target {
  id: string
  email: string
  firstName: string
  lastName: string
  customerId: string | null
  cardLast4: string | null
  termsVersion: string | null
  scheduleVersion: number | null
}

async function main() {
  requireEnv(['dev'], 'give providers a test card')

  const checkOnly = process.argv.includes('--check')
  const key = process.env.STRIPE_SECRET_KEY_WRITE ?? ''

  if (!key) {
    console.error('STRIPE_SECRET_KEY_WRITE is not set — nothing can be done without it.')
    process.exitCode = 1
    return
  }
  if (!key.includes('_test_')) {
    // The important guard. `requireEnv` proves which DATABASE this is; it says nothing about
    // which Stripe account the key points at, and the two are configured separately.
    console.error(
      'STRIPE_SECRET_KEY_WRITE is not a test key. This attaches a card and makes providers\n' +
        'chargeable — refusing to do that against live Stripe.',
    )
    process.exitCode = 1
    return
  }

  console.log(`${checkOnly ? 'Checking' : 'Preparing'} ${describeDatabase()}\n`)

  const schedule = await liveScheduleVersion()
  if (schedule === null) {
    console.error('No fee schedule is published. Run `npm run etl:rental-fees` first.')
    process.exitCode = 1
    return
  }

  // Everyone who could actually book. The house provider pays no rent and needs neither a card
  // nor an acceptance, so including it would invent a fixture nothing uses.
  const targets = (await db
    .select({
      id: providers.id,
      email: providers.email,
      firstName: providers.firstName,
      lastName: providers.lastName,
      customerId: providers.stripeBillingCustomerId,
      cardLast4: providers.billingCardLast4,
      termsVersion: providers.rentalTermsVersion,
      scheduleVersion: providers.rentalScheduleVersion,
    })
    .from(providers)
    .where(
      sql`${providers.status} = 'active'
          AND ${providers.bookingEnabled}
          AND ${providers.revenueModel} <> 'house'`,
    )) as Target[]

  if (targets.length === 0) {
    console.log('  No bookable providers. Run `npm run dev:e2e-credentials` first.')
    return
  }

  let changes = 0
  let failed = 0

  for (const p of targets) {
    const who = `${p.firstName} ${p.lastName}`.padEnd(20)
    const needsCard = !p.cardLast4
    const needsTerms = p.termsVersion !== RENTAL_TERMS_VERSION || p.scheduleVersion !== schedule

    if (!needsCard && !needsTerms) {
      console.log(`  ok       ${who} card ••${p.cardLast4}, accepted v${p.scheduleVersion}`)
      continue
    }

    changes += 1

    if (checkOnly) {
      const missing = [needsCard && 'no card', needsTerms && 'terms not current']
        .filter(Boolean)
        .join(', ')
      console.log(`  needs    ${who} ${missing}`)
      continue
    }

    let customerId = p.customerId
    let last4 = p.cardLast4

    if (needsCard) {
      try {
        // A customer id copied in from production by the nightly refresh belongs to the LIVE
        // Stripe account and does not exist in test. Reusing it fails with "No such customer",
        // which reads like a permissions problem and is not — so it is checked and replaced.
        if (customerId && !(await stripeHas(`/customers/${customerId}`))) {
          console.log(`           ${p.firstName}: ${customerId} is a live id, replacing`)
          customerId = null
        }

        if (!customerId) {
          const customer = await stripePost<{ id: string }>('/customers', {
            email: p.email,
            name: `${p.firstName} ${p.lastName}`,
            metadata: { provider_id: p.id, source: 'dev-rental-ready' },
          })
          customerId = customer.id

          // Written immediately. If the payment method call fails below, a re-run must reuse
          // this customer rather than leaving a trail of orphans in the Stripe test account.
          await db
            .update(providers)
            .set({ stripeBillingCustomerId: customerId })
            .where(eq(providers.id, p.id))
        }

        // A fresh payment method per provider rather than attaching the shared `pm_card_visa`
        // token, which Stripe refuses once it is already on another customer.
        const method = await stripePost<{
          id: string
          card?: { last4?: string; brand?: string; exp_month?: number; exp_year?: number }
        }>('/payment_methods', { type: 'card', card: { token: TEST_CARD_TOKEN } })
        await stripePost(`/payment_methods/${method.id}/attach`, { customer: customerId })
        await stripePost(`/customers/${customerId}`, {
          'invoice_settings[default_payment_method]': method.id,
        })

        last4 = method.card?.last4 ?? '4242'

        await db
          .update(providers)
          .set({
            stripeBillingCustomerId: customerId,
            billingPaymentMethodId: method.id,
            billingCardBrand: method.card?.brand ?? 'visa',
            billingCardLast4: last4,
            billingCardExpMonth: method.card?.exp_month ?? null,
            billingCardExpYear: method.card?.exp_year ?? null,
          })
          .where(eq(providers.id, p.id))
      } catch (err) {
        // A restricted key without write access to payment methods is the likely cause, and the
        // message Stripe returns for it is not obvious. Say what to do about it.
        failed += 1
        console.error(`  FAILED   ${who} ${err instanceof Error ? err.message : err}`)
        console.error(
          '           If this is a permissions error, the restricted key needs write access\n' +
            '           to Customers and PaymentMethods — or use the Add a card button instead.',
        )
        process.exitCode = 1
        continue
      }
    }

    if (needsTerms) {
      await db
        .update(providers)
        .set({
          rentalTermsAckAt: new Date(),
          rentalTermsVersion: RENTAL_TERMS_VERSION,
          rentalScheduleVersion: schedule,
        })
        .where(eq(providers.id, p.id))
    }

    const did = [needsCard && `card ••${last4}`, needsTerms && `accepted v${schedule}`]
      .filter(Boolean)
      .join(', ')
    console.log(`  ready    ${who} ${did}`)
  }

  // ---- stale live customers on everybody else ----
  //
  // The loop above only touches providers who can book. A provider who cannot — an inactive
  // account, the medical director, somebody mid-setup — still carries whatever billing customer
  // the nightly copy brought over, and the first thing they would hit on adding a card is "No
  // such customer". Cheap to clear, and it keeps this script's repair matched to what
  // `dev-usable.ts` asserts.
  const strays = (await db
    .select({
      id: providers.id,
      email: providers.email,
      customerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(
      sql`${providers.stripeBillingCustomerId} IS NOT NULL
          AND ${providers.billingPaymentMethodId} IS NULL
          AND ${providers.status} = 'active'
          AND ${providers.revenueModel} <> 'house'`,
    )) as { id: string; email: string; customerId: string }[]

  for (const stray of strays) {
    if (await stripeHas(`/customers/${stray.customerId}`)) continue

    changes += 1
    if (checkOnly) {
      console.log(`  stale    ${stray.email} holds live customer ${stray.customerId}`)
      continue
    }

    await db
      .update(providers)
      .set({ stripeBillingCustomerId: null })
      .where(eq(providers.id, stray.id))
    console.log(`  cleared  ${stray.email} live customer ${stray.customerId}`)
  }

  if (changes === 0) {
    console.log('\nEvery bookable provider can already book.')
    return
  }

  if (checkOnly) {
    console.log(`\n${changes} provider(s) cannot book. Re-run without --check.`)
    process.exitCode = 1
    return
  }

  if (failed > 0) {
    // Counted separately and said last. A summary reporting only what worked is how a
    // half-prepared environment gets treated as a ready one.
    console.error(`
${changes - failed} prepared, ${failed} FAILED — see above.`)
    process.exitCode = 1
    return
  }

  console.log(`\n${changes} provider(s) prepared.`)
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
