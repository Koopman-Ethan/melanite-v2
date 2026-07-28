import { expect, test } from '@playwright/test'

import '../envConfig'

// The medical director.
//
// This role could not sign in at all: he counted as an admin VIEW (so every provider item was
// hidden) but not as an admin (so `requireAdmin` turned him away), and his Dashboard link
// pointed at /app/admin, which redirected to /app, which pointed at /app/admin. The browser
// gave up after about seventy redirects. So the first thing worth asserting is simply that he
// arrives somewhere.
//
// Signs in fresh rather than reusing a stored session — the bug WAS the sign-in.

async function sql() {
  const { neon } = await import('@neondatabase/serverless')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set — the e2e suite needs a real database')
  return neon(url)
}

const PASSWORD = 'Oversight-Aa1!probe'

/** A throwaway director, so the test never touches the real one's account or password. */
async function makeDirector(): Promise<{ email: string; id: string }> {
  const { hashPassword } = await import('../lib/auth/password')
  const query = await sql()
  const email = `zz.onboard.director.${Date.now()}@example.com`
  const rows = (await query.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled)
     VALUES ($1, $2, false, 'Probe', 'Director', 'medical_director', 'active', 6, false)
     RETURNING id`,
    [email, await hashPassword(PASSWORD)],
  )) as { id: string }[]
  return { email, id: rows[0].id }
}

test.describe('medical director', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'workflow, covered once')

  test('can sign in and lands on oversight', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const { email, id } = await makeDirector()
    const query = await sql()

    const hops: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) hops.push(new URL(frame.url()).pathname)
    })

    await page.goto('/login')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()

    await expect(page).toHaveURL(/\/app\/oversight/)
    await expect(page.getByRole('heading', { name: 'Oversight' })).toBeVisible()

    // The loop produced ~70 navigations. A healthy sign-in is a handful.
    expect(hops.length, `redirect loop: ${hops.slice(0, 10).join(' -> ')}`).toBeLessThan(10)

    // --- He sees who he covers, and what they perform ---------------------------------------
    await expect(page.getByText(/under your direction/i)).toBeVisible()
    // The clinical scope is the point: a calendar alone does not say what procedures are being
    // performed under his license.
    await expect(page.getByText('Performs').first()).toBeVisible()

    // --- And none of the money ---------------------------------------------------------------
    await page.goto('/app/admin/revenue')
    await expect(page).not.toHaveURL(/revenue/)
    await page.goto('/app/admin/providers')
    await expect(page).not.toHaveURL(/providers/)
    await page.goto('/app/admin/tools')
    await expect(page).not.toHaveURL(/tools/)

    // Provider surfaces are not offered to him either. They stay REACHABLE by URL, and that
    // is deliberate rather than overlooked: every one is scoped to the signed-in user, so a
    // director who types /app/earnings sees his own empty earnings, not a provider's. Blocking
    // them outright would settle a question nobody has asked yet — whether Keoni, who is
    // platform_owner AND booking-enabled, may take clients himself.
    const nav = page.getByRole('navigation')
    await page.goto('/app/oversight')
    await expect(nav.getByRole('link', { name: 'Earnings' })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Book Laser Time' })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Oversight' })).toBeVisible()

    await query.query(`DELETE FROM sessions WHERE provider_id = $1`, [id])
    await query.query(`DELETE FROM providers WHERE id = $1`, [id])
  })

})

test.describe('medical director, as a signed-in provider', () => {
  test.use({ storageState: 'e2e/.auth/provider.json' })

  test('oversight is closed to providers', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    await page.goto('/app/oversight')
    await expect(page).not.toHaveURL(/oversight/)
  })
})
