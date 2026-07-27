import { randomBytes } from 'node:crypto'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import '../envConfig'

// The other journey a real person takes through this app: an invited provider going from an
// emailed link to an account that can be used.
//
// This one matters more than it looks. Every provider meets it exactly once, on their first
// day, with no support and no prior knowledge of the product — and a dead end here costs a
// provider rather than a booking. It is also the only flow that writes to `status`, which is
// what the rest of the app gates on.
//
// Signed out on purpose: `test.use({ storageState })` is deliberately absent, because the
// account under test does not exist yet — which is also why the accessibility suite cannot
// reach these six screens. It signs in as a provider who has finished setup, and every one of
// these pages redirects them away. So the axe scan happens HERE, inside the only session that
// can see them, and it runs on the phone viewport too: a new provider setting themselves up on
// a phone is the normal case, not the edge one.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function expectAccessible(page: Page, where: string) {
  // Transitions are stopped before measuring, and it is not a convenience.
  //
  // Buttons carry `transition-all duration-150`, so in the moment after one is enabled or
  // changes variant it is partway between two colours. axe sampled a half-faded gold button and
  // reported it as a contrast failure — intermittently, and only when the machine was busy
  // enough to land the scan inside those 150ms. Freezing animation measures the colours a
  // person actually reads instead of a frame nobody sees.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important }',
  })

  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze()
  const detail = results.violations
    .map((v) => `  [${v.impact}] ${v.id} — ${v.help} (${v.nodes[0]?.target.join(' ')})`)
    .join('\n')
  expect(results.violations, `\n${where}:\n${detail}\n`).toEqual([])
}

/** Direct SQL. The flow's whole point is that the UI does the writing — asserting through
 *  Drizzle would only re-run the app's own code and prove nothing. */
async function sql() {
  const { neon } = await import('@neondatabase/serverless')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set — the e2e suite needs a real database')
  return neon(url)
}

/** Real invites are always issued BY somebody — `invited_by_admin_id` is not nullable, which
 *  is the right call: an invite with no author is an invite nobody can be asked about. */
type Query = Awaited<ReturnType<typeof sql>>

async function inviteFrom(
  query: Query,
  values: { email: string; token: string; status: string; expiresIn: string },
) {
  await query.query(
    `INSERT INTO invite_links (email, token, status, expires_at, accepted_at, invited_by_admin_id)
     VALUES ($1, $2, $3::invite_status, now() + $4::interval,
             CASE WHEN $3 = 'accepted' THEN now() END,
             (SELECT id FROM providers WHERE role IN ('platform_owner', 'developer') ORDER BY email LIMIT 1))`,
    [values.email, values.token, values.status, values.expiresIn],
  )
}

test.describe('provider onboarding', () => {
  test('an invite becomes an active provider who still cannot book', async ({ page }) => {
    const query = await sql()
    const token = randomBytes(24).toString('base64url')
    const email = `zz.onboard.${Date.now()}@example.com`

    await inviteFrom(query, { email, token, status: 'pending', expiresIn: '7 days' })

    // --- Step 1: the emailed link ---------------------------------------------------------
    await page.goto(`/onboard/${token}`)
    await expect(page.getByRole('heading', { name: /secure your account/i })).toBeVisible()

    // The email is shown and not editable — the invite decides who this account belongs to.
    await expect(page.getByLabel('Email')).toHaveValue(email)
    await expectAccessible(page, 'step 1 — create password')

    const password = `E2e-Onboard-${randomBytes(6).toString('hex')}!`
    await page.getByLabel('Create password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password').fill(password)
    await page.getByRole('button', { name: 'Activate account' }).click()

    // --- Step 2: profile ------------------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/profile/)
    await expect(page.getByText('Step 2 of 6')).toBeVisible()
    await expectAccessible(page, 'step 2 — profile')

    await page.getByLabel('First name').fill('Zzonboard')
    await page.getByLabel('Last name').fill('Tester')
    await page.getByLabel('Phone number').fill('208-555-0134')
    await page.getByRole('button', { name: /continue/i }).click()

    // --- Step 3: licence ------------------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/license/)

    await expectAccessible(page, 'step 3 — licence')

    await page.getByLabel('Licence number').fill('RN-E2E-0001')
    await page.getByLabel('Licence state').fill('Idaho')
    await page.getByLabel('Licence expiry').fill('2099-12-31')
    await page.getByRole('button', { name: /continue to stripe/i }).click()

    // --- Step 4: Stripe -------------------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/stripe/)

    // Stripe's hosted onboarding is not automated here — it is Stripe's form, not this app's,
    // and driving it would test their product. What IS this app's logic is what happens when a
    // provider comes BACK holding an account id, so that state is set directly.
    await query.query(`UPDATE providers SET stripe_account_id = $1 WHERE email = $2`, [
      `acct_e2e_${randomBytes(6).toString('hex')}`,
      email,
    ])
    await page.reload()

    // Connected-but-unverified is the state nearly every provider is in at this moment, and it
    // must not block them.
    await expect(page.getByText(/is verifying them/i)).toBeVisible()
    await expectAccessible(page, 'step 4 — Stripe')
    await page.getByRole('button', { name: 'Next step' }).click()

    // --- Step 5: medical director ---------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/director/)

    // The own-director path, so a test run never opens a Stripe subscription.
    await page.getByRole('button', { name: /use my own director/i }).click()
    await expect(page.getByText(/an active subscription alone/i)).toBeVisible()
    await expectAccessible(page, 'step 5 — medical director')
    await page.getByRole('button', { name: /continue to services/i }).click()

    // --- Step 6: services -----------------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/services/)

    // Nothing selected means nothing to sell; the button stays disabled rather than failing on
    // submit.
    const finish = page.getByRole('button', { name: /finish setup/i })
    await expect(finish).toBeDisabled()

    await page.locator('input[type="checkbox"]').first().check()

    // Scanned with a service expanded, because the price and duration inputs only exist then.
    await expect(finish).toBeEnabled()
    await expectAccessible(page, 'step 6 — services')
    await page.getByLabel('Your price').fill('225')
    await finish.click()

    // --- Done -----------------------------------------------------------------------------
    await expect(page).toHaveURL(/\/app\/onboarding\/done/)
    await expect(page.getByRole('heading', { name: /all set/i })).toBeVisible()

    // The point of that screen: finishing setup is not the same as being cleared to practise.
    await expect(page.getByText(/send your documents to melanite/i)).toBeVisible()
    await expectAccessible(page, 'setup complete')

    // --- What actually landed in the database ---------------------------------------------
    const rows = (await query.query(
      `SELECT p.status, p.onboarding_step, p.booking_enabled, p.medical_director_type,
              p.license_number, p.first_name,
              (SELECT count(*) FROM provider_services ps WHERE ps.provider_id = p.id) AS services
         FROM providers p WHERE p.email = $1`,
      [email],
    )) as Record<string, unknown>[]

    expect(rows).toHaveLength(1)
    const provider = rows[0]

    expect(provider.status, 'setup should activate the account').toBe('active')
    expect(Number(provider.onboarding_step)).toBe(6)
    expect(provider.license_number).toBe('RN-E2E-0001')
    expect(provider.medical_director_type).toBe('own')
    expect(Number(provider.services), 'the chosen service was not saved').toBeGreaterThan(0)

    // The load-bearing assertion. An active provider is NOT a booking-enabled one: Melanite
    // still confirms insurance and medical-director documents by hand. If this ever comes back
    // true, someone can take clients on the strength of an email address.
    expect(provider.booking_enabled, 'finishing setup must not unlock booking').toBe(false)

    // The invite is spent, so the same link cannot mint a second account.
    const invites = (await query.query(`SELECT status FROM invite_links WHERE token = $1`, [
      token,
    ])) as Record<string, unknown>[]
    expect(invites[0]?.status).toBe('accepted')

    // --- And setup does not re-open -------------------------------------------------------
    // Someone who bookmarked step 2 partway through must not be able to walk back in from a
    // stale tab and rewrite their whole service menu.
    await page.goto('/app/onboarding/profile')
    await expect(page).toHaveURL(/\/app\/dashboard/)
  })

  test('a spent invite cannot create a second account', async ({ page }) => {
    const query = await sql()
    const token = randomBytes(24).toString('base64url')
    const email = `zz.onboard.spent.${Date.now()}@example.com`

    await inviteFrom(query, { email, token, status: 'accepted', expiresIn: '7 days' })

    await page.goto(`/onboard/${token}`)
    await expect(page.getByText(/already been used/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0)
  })

  test('an expired invite says so, and says what to do about it', async ({ page }) => {
    const query = await sql()
    const token = randomBytes(24).toString('base64url')
    const email = `zz.onboard.old.${Date.now()}@example.com`

    await inviteFrom(query, { email, token, status: 'pending', expiresIn: '-1 day' })

    await page.goto(`/onboard/${token}`)
    await expect(page.getByText(/expired/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0)
  })
})
