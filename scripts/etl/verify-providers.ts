// Reconciles loaded PROVIDERS against Xano and against Stripe.
//
// verify.ts checks the money, and does it well. Nothing checked anything else — and every
// provider field is a straight copy from Xano (see transform.ts:95-105), so whatever v1 held
// became the truth in v2 whether or not it was correct. Three defects reached the dev database
// that way, and all three were found by accident while building unrelated features:
//
//   - a stripe_account_id the platform cannot resolve, on a BOOKING-ENABLED provider. Bookings
//     use destination charges, so that id is named in the charge: in production a client
//     reaches checkout and the payment fails in front of them.
//   - a stripe_onboarding_complete of false while Stripe reported payouts enabled — a stale v1
//     flag, copied faithfully.
//   - bookable providers with no licence expiry at all, which the licence gate reads as valid,
//     so they clear a compliance check nobody ever performed.
//
// The point is not those three. It is that nobody had ever compared the loaded providers to
// their sources, so the real count was unknown. This makes it known.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/verify-providers.ts
//
// Read-only. It changes nothing and exits non-zero if anything disagrees.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { neon } from '@neondatabase/serverless'

import '../../envConfig'

import { PROVIDER_CORRECTIONS, isCorrected } from './corrections'

interface XanoProvider {
  id: string
  email: string
  first_name: string
  last_name: string
  stripe_account_id: string | null
  stripe_onboarding_complete: boolean | null
  license_number: string | null
  license_expiry: string | number | null
  booking_enabled: boolean | null
  status: string | null
}

interface LoadedProvider {
  email: string
  first_name: string
  last_name: string
  status: string
  booking_enabled: boolean
  stripe_account_id: string | null
  stripe_onboarding_complete: boolean
  license_number: string | null
  license_expiry: string | null
}

const sql = neon(process.env.DATABASE_URL!)
const STRIPE = process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY_WRITE ?? ''

const problems: string[] = []
const notes: string[] = []
let unreadable = false
const fail = (who: string, what: string) => problems.push(`${who.padEnd(32)} ${what}`)

interface PlatformAccount {
  id: string
  payouts_enabled: boolean
}

/** Every Connect account on the platform, by id.
 *
 *  LISTED rather than fetched one at a time, and the difference matters. Stripe answers
 *  GET /v1/accounts/{id} with 403 both when the key may not see the account AND when the
 *  account does not exist — deliberately, so an id cannot be probed for validity. It never
 *  returns 404. So "fetch it and check the status" cannot tell a dead id from a live one,
 *  which is the single fact this check exists to establish.
 *
 *  Listing sidesteps that entirely: an id absent from the platform's own list is not ours.
 *  Fewer calls, and an answer that means what it says.
 *
 *  Returns null when the key cannot list at all, so "could not check" stays distinct from
 *  "checked and found nothing".
 */
async function platformAccounts(): Promise<Map<string, PlatformAccount> | null> {
  if (!STRIPE) return null

  const accounts = new Map<string, PlatformAccount>()
  let startingAfter: string | undefined

  for (let page = 0; page < 20; page++) {
    const url = new URL('https://api.stripe.com/v1/accounts')
    url.searchParams.set('limit', '100')
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE}` } })
    if (!res.ok) return null

    const body = (await res.json()) as { data: PlatformAccount[]; has_more: boolean }
    for (const account of body.data) accounts.set(account.id, account)

    if (!body.has_more || body.data.length === 0) return accounts
    startingAfter = body.data[body.data.length - 1].id
  }

  return accounts
}

async function main() {
  const staged: XanoProvider[] = JSON.parse(
    readFileSync(join('scripts/etl/staged/xano/providers.json'), 'utf8'),
  )
  const loaded = (await sql.query(
    `SELECT email, first_name, last_name, status, booking_enabled, stripe_account_id,
            stripe_onboarding_complete, license_number, license_expiry::text
       FROM providers`,
  )) as unknown as LoadedProvider[]

  const byEmail = new Map(loaded.map((p) => [p.email.toLowerCase(), p]))

  console.log(`Xano: ${staged.length} providers   Loaded: ${loaded.length}`)

  // Printed every run. A correction that nobody sees is a silent edit to somebody's record,
  // and the difference between a decision and a mystery is whether it was stated out loud.
  console.log(`\n${PROVIDER_CORRECTIONS.length} declared correction(s) to v1 data:`)
  for (const correction of PROVIDER_CORRECTIONS) {
    console.log(`  ${correction.email} — ${Object.keys(correction.set).join(', ')}`)
  }
  console.log()

  // --- every provider in the source arrived ------------------------------------------------
  for (const source of staged) {
    const email = (source.email ?? '').toLowerCase()
    const got = byEmail.get(email)
    if (!got) {
      fail(email || '(no email)', 'in Xano but NOT loaded')
      continue
    }

    // Fields copied verbatim must actually match. A silent transform bug looks exactly like
    // correct data until somebody checks — EXCEPT where corrections.ts declares the difference
    // on purpose, which is the one case where disagreeing with v1 is the correct outcome.
    if (
      String(source.stripe_account_id ?? '') !== String(got.stripe_account_id ?? '') &&
      !isCorrected(email, 'stripeAccountId')
    ) {
      fail(email, `stripe_account_id differs: xano=${source.stripe_account_id} db=${got.stripe_account_id}`)
    }
    if (String(source.license_number ?? '') !== String(got.license_number ?? '')) {
      fail(email, `license_number differs: xano=${source.license_number} db=${got.license_number}`)
    }
  }

  // --- anything loaded that was not in the source -------------------------------------------
  const sourceEmails = new Set(staged.map((p) => (p.email ?? '').toLowerCase()))
  for (const got of loaded) {
    if (!sourceEmails.has(got.email.toLowerCase())) {
      notes.push(`${got.email} exists in v2 but not in the Xano export (created after the pull?)`)
    }
  }

  // --- Stripe: can every stored account actually be paid? -----------------------------------
  console.log('Checking Connect accounts against Stripe...')
  const platform = await platformAccounts()

  if (!platform) {
    unreadable = true
  } else {
    console.log(`  ${platform.size} Connect account(s) on the platform
`)
  }

  for (const got of loaded) {
    if (!got.stripe_account_id) {
      if (got.booking_enabled) {
        notes.push(`${got.email} is booking-enabled with no Stripe account — cannot be paid`)
      }
      continue
    }
    if (!platform) continue

    const account = platform.get(got.stripe_account_id)

    if (!account) {
      // The one that fails in front of a client. Destination charges name this id, so the
      // charge is rejected at the moment they try to pay.
      fail(
        got.email,
        `stripe_account_id ${got.stripe_account_id} is NOT on this platform` +
          (got.booking_enabled ? ' — and they are booking-enabled' : ''),
      )
      continue
    }

    if (account.payouts_enabled !== got.stripe_onboarding_complete) {
      fail(
        got.email,
        `stripe_onboarding_complete=${got.stripe_onboarding_complete} but Stripe says ` +
          `payouts_enabled=${account.payouts_enabled}`,
      )
    }
  }

  // Every account the platform has that no provider claims. A provider paid into an account
  // the database does not know about is money going somewhere nobody is looking.
  if (platform) {
    const claimed = new Set(loaded.map((p) => p.stripe_account_id).filter(Boolean))
    for (const id of platform.keys()) {
      if (!claimed.has(id)) notes.push(`Stripe account ${id} belongs to no provider in the database`)
    }
  }

  // --- every declared correction actually took effect ----------------------------------------
  // A correction nobody applied is worse than no correction, because the file says it is
  // handled. This is what stops corrections.ts becoming a wish list.
  for (const correction of PROVIDER_CORRECTIONS) {
    const got = byEmail.get(correction.email.toLowerCase())
    if (!got) continue

    if (correction.set.stripeAccountId === null && got.stripe_account_id !== null) {
      fail(correction.email, 'correction NOT applied: stripe_account_id should be cleared')
    }
    if (correction.set.bookingEnabled === false && got.booking_enabled) {
      fail(correction.email, 'correction NOT applied: booking_enabled should be false')
    }
  }

  // --- gates that pass because a field is empty ---------------------------------------------
  for (const got of loaded) {
    if (!got.booking_enabled || got.status !== 'active') continue

    // `isLicenseExpired` returns false for a null expiry, so a missing date clears the licence
    // gate rather than blocking it. Importing nulls imports providers who bypass it.
    if (!got.license_expiry) {
      fail(got.email, 'booking-enabled with NO licence expiry — the licence gate cannot fire')
    }
    if (!got.license_number) {
      fail(got.email, 'booking-enabled with no licence number on file')
    }
  }

  // --- report --------------------------------------------------------------------------------
  if (notes.length) {
    console.log(`\n${notes.length} thing(s) worth knowing:`)
    for (const n of notes) console.log(`  ${n}`)
  }

  if (unreadable) {
    // Loud, because an unchecked check is the dangerous kind — it looks like a pass.
    console.log(
      [
        ``,
        `CONNECT ACCOUNTS NOT VERIFIED.`,
        `  STRIPE_SECRET_KEY could not list /v1/accounts, so this run could not tell a live`,
        `  account from a dead one. Give it the Connect > Read permission and run again`,
        `  BEFORE migrating — a dead account id means a client reaches checkout and the`,
        `  payment fails in front of them.`,
      ].join('\n'),
    )
  }

  if (problems.length === 0) {
    console.log('\nProviders reconcile against Xano and Stripe.')
  } else {
    console.log(`\n${problems.length} PROBLEM(S):`)
    for (const p of problems) console.log(`  ${p}`)
  }

  // Unverified is not the same as passed. Exiting 0 here would let a migration proceed on the
  // strength of a check that never ran.
  process.exitCode = problems.length === 0 && !unreadable ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
