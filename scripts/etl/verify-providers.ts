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
let forbidden = 0
const fail = (who: string, what: string) => problems.push(`${who.padEnd(32)} ${what}`)

type AccountLookup =
  | { kind: 'found'; payoutsEnabled: boolean }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }

/** Asks Stripe about a Connect account.
 *
 *  404 and 403 mean COMPLETELY different things and the first version of this treated them as
 *  one: "the account is gone" versus "this key may not ask". Both restricted keys in .env.local
 *  return 403 for /v1/accounts, so that version reported every single provider as having a
 *  dead Stripe account — seven false alarms on a screen whose whole job is to be believed. */
async function stripeAccount(id: string): Promise<AccountLookup> {
  if (!STRIPE) return { kind: 'unavailable' }

  const res = await fetch(`https://api.stripe.com/v1/accounts/${id}`, {
    headers: { Authorization: `Bearer ${STRIPE}` },
  })

  if (res.status === 404) return { kind: 'missing' }
  if (res.status === 403) return { kind: 'forbidden' }
  if (!res.ok) return { kind: 'unavailable' }

  const body = (await res.json()) as { payouts_enabled: boolean }
  return { kind: 'found', payoutsEnabled: body.payouts_enabled }
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

  console.log(`Xano: ${staged.length} providers   Loaded: ${loaded.length}\n`)

  // --- every provider in the source arrived ------------------------------------------------
  for (const source of staged) {
    const email = (source.email ?? '').toLowerCase()
    const got = byEmail.get(email)
    if (!got) {
      fail(email || '(no email)', 'in Xano but NOT loaded')
      continue
    }

    // Fields copied verbatim must actually match. A silent transform bug looks exactly like
    // correct data until somebody checks.
    if (String(source.stripe_account_id ?? '') !== String(got.stripe_account_id ?? '')) {
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
  for (const got of loaded) {
    if (!got.stripe_account_id) {
      if (got.booking_enabled) {
        notes.push(`${got.email} is booking-enabled with no Stripe account — cannot be paid`)
      }
      continue
    }

    const account = await stripeAccount(got.stripe_account_id)

    if (account.kind === 'forbidden') {
      forbidden += 1
      continue
    }
    if (account.kind === 'unavailable') continue

    if (account.kind === 'missing') {
      // The one that fails in front of a client. Destination charges name this id.
      fail(
        got.email,
        `stripe_account_id ${got.stripe_account_id} DOES NOT EXIST on this platform` +
          (got.booking_enabled ? ' — and they are booking-enabled' : ''),
      )
      continue
    }

    if (account.payoutsEnabled !== got.stripe_onboarding_complete) {
      fail(
        got.email,
        `stripe_onboarding_complete=${got.stripe_onboarding_complete} but Stripe says ` +
          `payouts_enabled=${account.payoutsEnabled}`,
      )
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

  if (forbidden > 0) {
    // Loud, because an unchecked check is the dangerous kind — it looks like a pass.
    console.log(
      [
        ``,
        `CONNECT ACCOUNTS NOT VERIFIED (${forbidden} of them).`,
        `  The key in STRIPE_SECRET_KEY returned 403 for /v1/accounts, so this run could not`,
        `  tell a live account from a deleted one. Give it the Connect > Read permission, or`,
        `  point STRIPE_SECRET_KEY at a key that has it, and run again BEFORE migrating.`,
        `  A dead account id here means a client reaches checkout and the payment fails.`,
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
  process.exitCode = problems.length === 0 && forbidden === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
