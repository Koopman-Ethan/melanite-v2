import { randomBytes } from 'node:crypto'

import { chromium } from '@playwright/test'
import { neon } from '@neondatabase/serverless'

import '../envConfig'

// Proves the two Stripe paths in onboarding against Stripe itself, not against a database write.
//
// Everything else in the suite fakes these: the e2e journey sets `stripe_account_id` directly
// and never asks Stripe whether an account exists, and the step-5 gate has only ever been
// tested by setting `medical_director_status` by hand. That is a reasonable thing for a test
// suite to do — it must not create Connect accounts on every run — but it means the code that
// actually talks to Stripe had never run once.
//
// Needs, in three terminals:
//   stripe listen --forward-to http://localhost:3114/api/webhooks/stripe
//   npx tsx --tsconfig scripts/tsconfig.json scripts/webhook-bridge.ts <cli-secret> 3114
//   npx tsx --tsconfig scripts/tsconfig.json scripts/verify-stripe-onboarding.ts
//
// TEST MODE ONLY. It refuses to run against a live key. Everything it creates in Stripe and in
// the database is deleted at the end.

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3113'
const query = neon(process.env.DATABASE_URL!)

const KEY = process.env.STRIPE_CLI_KEY ?? process.env.STRIPE_SECRET_KEY_WRITE ?? ''
if (!KEY.includes('_test_')) {
  throw new Error('Refusing to run: the key is not a test-mode key.')
}

const email = `zz.onboard.stripe.${Date.now()}@example.com`
const password = `Stripe-Verify-${randomBytes(4).toString('hex')}!`

async function stripe<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? encode(body) : undefined,
  })
  const json = (await res.json()) as T & { error?: { message: string } }
  if (json.error) throw new Error(`${path}: ${json.error.message}`)
  return json
}

/** Stripe takes bracketed form encoding, not JSON. */
function encode(obj: Record<string, unknown>, prefix = ''): string {
  return Object.entries(obj)
    .flatMap(([k, v]) => {
      const key = prefix ? `${prefix}[${k}]` : k
      if (v === undefined || v === null) return []
      if (typeof v === 'object') return [encode(v as Record<string, unknown>, key)]
      return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`]
    })
    .join('&')
}

async function providerRow() {
  const [row] = (await query.query(
    `SELECT id, stripe_account_id, stripe_onboarding_complete, medical_director_status,
            onboarding_step
       FROM providers WHERE email = $1`,
    [email],
  )) as Record<string, unknown>[]
  return row
}

/** Webhooks are asynchronous. Waiting for the condition beats a fixed sleep that is either
 *  flaky or slow, and reporting how long it took is worth knowing. */
async function waitFor(label: string, check: () => Promise<boolean>, seconds = 40) {
  const started = Date.now()
  for (let i = 0; i < seconds * 2; i++) {
    if (await check()) {
      console.log(`  ${label} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`  TIMED OUT waiting for ${label}`)
  return false
}

async function main() {
  let failures = 0
  const fail = (msg: string) => {
    console.log(`  FAIL — ${msg}`)
    failures += 1
  }

  const token = randomBytes(24).toString('base64url')
  await query.query(
    `INSERT INTO invite_links (email, token, status, expires_at, invited_by_admin_id)
     VALUES ($1, $2, 'pending', now() + interval '7 days',
             (SELECT id FROM providers WHERE role IN ('platform_owner','developer')
               ORDER BY email LIMIT 1))`,
    [email, token],
  )

  const browser = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 200 })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } } as never)

  console.log('\n1. Walking a real provider to step 4')
  await page.goto(`${BASE}/onboard/${token}`)
  await page.getByLabel('Create password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Activate account' }).click()

  await page.waitForURL(/onboarding\/profile/)
  await page.getByLabel('First name').fill('Stripe')
  await page.getByLabel('Last name').fill('Verify')
  await page.getByLabel('Phone number').fill('(208) 555-0177')
  await page.getByLabel('Professional credentials').fill('RN')
  await page.getByRole('button', { name: /continue/i }).click()

  await page.waitForURL(/onboarding\/license/)
  await page.getByLabel('License number').fill('RN-STRIPE-1')
  await page.getByLabel('License state').fill('Idaho')
  await page.getByLabel('License expiry').fill('2030-01-31')
  await page.getByLabel('Malpractice insurance provider').fill('NSO')
  await page.getByRole('button', { name: /continue to stripe/i }).click()
  await page.waitForURL(/onboarding\/stripe/)

  // --- The real Connect call ---------------------------------------------------------------
  console.log('\n2. Connect — the app creates the account')
  await page.getByRole('button', { name: /connect bank account/i }).click()
  await page.waitForURL(/connect\.stripe\.com/, { timeout: 30_000 })
  console.log(`  redirected to ${new URL(page.url()).host}`)

  const row = await providerRow()
  const accountId = row?.stripe_account_id as string | null
  if (!accountId) fail('no stripe_account_id was stored')
  else console.log(`  stored ${accountId}`)

  // Asked of Stripe rather than assumed from our own row: the point is that it really exists.
  const account = await stripe<{ id: string; type: string; capabilities: Record<string, string> }>(
    `/accounts/${accountId}`,
  )
  console.log(`  Stripe confirms ${account.id} type=${account.type}`)
  // `inactive` is the correct state here: the capability was REQUESTED at creation and only
  // becomes active once Stripe has verified the person. Asserting 'active' at this point would
  // be asserting that Stripe is instant.
  if (!('transfers' in (account.capabilities ?? {})))
    fail('the transfers capability was never requested')
  else console.log(`  transfers capability: ${account.capabilities.transfers}`)

  // --- The hosted form is a human's job ----------------------------------------------------
  // Not automatable, and not for lack of trying. Stripe-collected Express accounts refuse
  // `individual`, `external_account` and `tos_acceptance` over the API — Stripe owns that data
  // collection by design — so the only route is the hosted form, which is behind a CAPTCHA.
  // Defeating bot detection is not something to automate around, so this stops and asks.
  console.log('\n3. Complete the hosted form (test data only), then this continues:')
  const link = await stripe<{ url?: string }>('/account_links', {
    account: accountId!,
    type: 'account_onboarding',
    refresh_url: `${BASE}/onboarding/stripe`,
    return_url: `${BASE}/onboarding/stripe?stripe=return`,
  })
  console.log(`\n     ${link.url}\n`)
  await page.goto(link.url!)

  const payoutsOn = await waitFor(
    'account.updated set stripe_onboarding_complete',
    async () => (await providerRow())?.stripe_onboarding_complete === true,
    600,
  )
  if (!payoutsOn) fail('account.updated never set stripe_onboarding_complete')

  // --- Back in the app ----------------------------------------------------------------------
  console.log('\n4. The provider returns and continues')
  await page.goto(`${BASE}/onboarding/stripe?stripe=return`)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.waitForURL(/onboarding\/director/)
  console.log('  reached step 5')

  // --- The subscription gate ------------------------------------------------------------------
  console.log('\n5. Medical director — the gate holds while unpaid')
  const blocked = await page.getByRole('button', { name: /continue to services/i }).count()
  if (blocked !== 0) fail('Melanite director path offered a Continue button while unpaid')
  else console.log('  no way forward on the Melanite path, as intended')

  // A real subscription on the real price, paid with a test card token, carrying the metadata
  // the handler reads. This is what Checkout produces, minus the hosted card form.
  const priceId = process.env.STRIPE_MD_PRICE_ID!
  const customer = await stripe<{ id: string }>('/customers', {
    email,
    payment_method: 'pm_card_visa',
    invoice_settings: { default_payment_method: 'pm_card_visa' },
  })
  const providerId = (await providerRow())?.id as string
  const subscription = await stripe<{ id: string; status: string }>('/subscriptions', {
    customer: customer.id,
    items: { 0: { price: priceId } },
    metadata: { provider_id: providerId },
  })
  console.log(`  subscription ${subscription.id} status=${subscription.status}`)

  const active = await waitFor('medical_director_status became active', async () => {
    const r = await providerRow()
    return r?.medical_director_status === 'active'
  })
  if (!active) fail('the subscription webhook never opened the gate')

  console.log('\n6. The gate now opens')
  await page.reload()
  const continueBtn = page.getByRole('button', { name: /continue to services/i })
  if ((await continueBtn.count()) === 0) fail('still no Continue button after the subscription')
  else {
    await continueBtn.click()
    await page.waitForURL(/onboarding\/services/, { timeout: 15_000 })
    console.log('  reached step 6')
  }

  await browser.close()

  // --- Cleanup --------------------------------------------------------------------------------
  console.log('\nCleaning up')
  await stripe(`/subscriptions/${subscription.id}`, { cancel_at_period_end: 'false' }).catch(
    () => {},
  )
  await fetch(`https://api.stripe.com/v1/subscriptions/${subscription.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  })
  await fetch(`https://api.stripe.com/v1/customers/${customer.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  })
  await fetch(`https://api.stripe.com/v1/accounts/${accountId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` },
  })
  await query.query(
    `DELETE FROM sessions WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [email],
  )
  await query.query(
    `DELETE FROM memberships WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [email],
  )
  await query.query(
    `DELETE FROM ledger_entries WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [email],
  )
  await query.query(
    `DELETE FROM provider_services WHERE provider_id IN (SELECT id FROM providers WHERE email = $1)`,
    [email],
  )
  await query.query(`DELETE FROM providers WHERE email = $1`, [email])
  await query.query(`DELETE FROM invite_links WHERE email = $1`, [email])

  console.log(failures === 0 ? '\nPASS — every Stripe path verified' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
