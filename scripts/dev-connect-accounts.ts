import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { describeDatabase, requireEnv } from '../lib/env-guard'

// Gives every provider in a NON-PRODUCTION database a test-mode Stripe account.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-connect-accounts.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-connect-accounts.ts --check
//
// RUN IT AFTER EVERY ETL OF DEV, like scrub-dev.ts. A reload brings the live ids straight back.
//
// WHY THIS EXISTS
//
// Dev data comes from the v1 migration, so every provider carries a LIVE Connect account id.
// Test and live are separate universes: a test key cannot see a live account at all — Stripe
// returns 403, never 404. Every payment path here is a destination charge, so the moment the
// checkout page tries to create a PaymentIntent with `transfer_data.destination` set to an
// account the key cannot see, the call fails and the client is told "Could not start the
// payment. Try again shortly." — which is true, and useless, and will never come right no
// matter how many times they try.
//
// That made appdev unable to take a single payment: the one thing a pre-production environment
// exists to prove. The scrubber deliberately leaves Stripe ids alone on the grounds that
// scrambling them "would break the payment paths this environment exists to test". Correct in
// spirit, wrong in effect — the ids were already broken for this key. Replacing them with real
// test-mode accounts is what that comment actually wanted.
//
// The accounts are `custom` rather than `express` (which is what the app creates in
// production) purely because Express onboarding is a hosted flow a human has to click through,
// while Custom accepts the same details over the API and activates immediately in test mode.
// What matters for a destination charge is that the `transfers` capability is active, and both
// kinds provide it.

const q = neon(process.env.DATABASE_URL!)

const KEY = process.env.STRIPE_SECRET_KEY_WRITE ?? ''

async function stripe(path: string, body?: Record<string, string>, idempotencyKey?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  })
  return { ok: res.ok, status: res.status, body: (await res.json()) as Record<string, never> }
}

/** Can THIS key see the account? The only question that matters, and the one a 403 answers. */
async function visible(accountId: string | null): Promise<boolean> {
  if (!accountId) return false
  const res = await stripe(`/accounts/${accountId}`)
  return res.ok
}

interface Provider {
  id: string
  first_name: string
  last_name: string
  email: string
  stripe_account_id: string | null
}

async function main() {
  requireEnv(['dev'], 'replace provider Stripe accounts with test-mode ones')

  if (!KEY) throw new Error('STRIPE_SECRET_KEY_WRITE is not set')
  if (/^(sk|rk)_live/.test(KEY)) {
    // The guard that matters most. Pointed at a live key this would create real Connect
    // accounts and overwrite real ones on providers who are being paid through them.
    throw new Error(
      'STRIPE_SECRET_KEY_WRITE is a LIVE key. This script only ever runs against test mode.',
    )
  }

  const checkOnly = process.argv.includes('--check')
  console.log(`${checkOnly ? 'Checking' : 'Fixing'} ${describeDatabase()}\n`)

  const providers = (await q.query(
    `SELECT id, first_name, last_name, email, stripe_account_id FROM providers
      WHERE status = 'active' ORDER BY first_name`,
  )) as Provider[]

  let broken = 0
  let fixed = 0

  for (const p of providers) {
    const name = `${p.first_name} ${p.last_name}`.padEnd(22)

    if (await visible(p.stripe_account_id)) {
      console.log(`  ok       ${name} ${p.stripe_account_id}`)
      continue
    }

    broken++
    if (checkOnly) {
      console.log(`  UNUSABLE ${name} ${p.stripe_account_id ?? '(none)'} — invisible to this key`)
      continue
    }

    const created = await stripe(
      '/accounts',
      {
        type: 'custom',
        country: 'US',
        email: p.email,
        'capabilities[transfers][requested]': 'true',
        business_type: 'individual',
        'individual[first_name]': p.first_name,
        'individual[last_name]': p.last_name,
        'individual[email]': p.email,
        // Stripe's documented test values. No real person's details are involved.
        'individual[dob][day]': '1',
        'individual[dob][month]': '1',
        'individual[dob][year]': '1980',
        'individual[address][line1]': 'address_full_match',
        'individual[address][city]': 'Boise',
        'individual[address][state]': 'ID',
        'individual[address][postal_code]': '83702',
        'individual[address][country]': 'US',
        'individual[phone]': '+15005550006',
        'individual[id_number]': '000000000',
        'individual[ssn_last_4]': '0000',
        'business_profile[mcc]': '7298',
        'business_profile[url]': 'https://appdev.melanitesuite.com',
        'tos_acceptance[date]': String(Math.floor(Date.now() / 1000)),
        'tos_acceptance[ip]': '127.0.0.1',
        'metadata[provider_id]': p.id,
        'metadata[note]': 'dev only — created by scripts/dev-connect-accounts.ts',
      },
      // One per provider per run of this script, so a retry after a network wobble does not
      // leave a second account behind.
      `dev-connect:${p.id}`,
    )

    if (!created.ok) {
      const message = (created.body as { error?: { message?: string } }).error?.message
      console.log(`  FAILED   ${name} ${message ?? created.status}`)
      continue
    }

    const accountId = created.body.id as unknown as string

    // An external account, so payouts are enabled too. Without one the account still accepts
    // transfers, but the provider's payouts page has nothing to show and reads as broken.
    await stripe(`/accounts/${accountId}/external_accounts`, {
      'external_account[object]': 'bank_account',
      'external_account[country]': 'US',
      'external_account[currency]': 'usd',
      'external_account[account_holder_type]': 'individual',
      'external_account[routing_number]': '110000000',
      'external_account[account_number]': '000123456789',
    })

    const check = await stripe(`/accounts/${accountId}`)
    const caps = (check.body as { capabilities?: Record<string, string> }).capabilities ?? {}
    const transfers = caps.transfers ?? 'unknown'

    await q.query(`UPDATE providers SET stripe_account_id = $1 WHERE id = $2`, [accountId, p.id])
    fixed++

    console.log(
      `  fixed    ${name} ${accountId}  transfers=${transfers}` +
        (transfers === 'active' ? '' : '  <-- NOT ACTIVE, payments will still fail'),
    )
  }

  if (checkOnly) {
    console.log(
      broken === 0
        ? '\nEvery provider has an account this key can use.'
        : `\n${broken} provider(s) cannot take a payment in this environment.`,
    )
    process.exit(broken === 0 ? 0 : 1)
  }

  console.log(`\n${fixed} replaced. Live account ids are untouched in production.`)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
