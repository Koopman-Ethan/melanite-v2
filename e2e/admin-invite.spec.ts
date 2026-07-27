import { expect, test } from '@playwright/test'

import '../envConfig'

// The admin side of onboarding: the only door into the system.
//
// There is no self-service signup, so every provider who ever exists comes through this form.
// What is worth pinning down is not that a row appears — it is the handling of the token, which
// is a bearer credential: it must be recoverable when the email fails, must not silently change
// under a resend, and must stop working the moment an invite is revoked.

test.use({ storageState: 'e2e/.auth/admin.json' })

async function sql() {
  const { neon } = await import('@neondatabase/serverless')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set — the e2e suite needs a real database')
  return neon(url)
}

async function tokenFor(email: string): Promise<string> {
  const query = await sql()
  const rows = (await query.query(
    `SELECT token, status FROM invite_links WHERE email = $1 ORDER BY sent_at DESC LIMIT 1`,
    [email],
  )) as { token: string; status: string }[]
  return rows[0]?.token ?? ''
}

test.describe('inviting a provider', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'workflow, covered once')

  test('an invite can be issued, recovered, resent and revoked', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const email = `zz.onboard.admin.${Date.now()}@example.com`
    const query = await sql()

    await page.goto('/app/admin/tools')
    await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible()

    // Invite is the first tab — the most common reason to open this page.
    await page.getByLabel('Their email').fill(email)
    await page.getByRole('button', { name: 'Send invite' }).click()

    // The link is shown whichever way the email went. An admin who cannot see the link cannot
    // rescue a failed send, and email to example.com is refused by design.
    const shown = page.locator('p', { hasText: '/onboard/' })
    await expect(shown).toBeVisible()

    const issued = await tokenFor(email)
    expect(issued, 'no invite row was created').not.toBe('')
    expect(await shown.textContent()).toContain(issued)

    // It shows up as outstanding, attributed to whoever sent it.
    const row = page.locator('li', { hasText: email }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('invited by')

    // --- Show link recovers it after a reload -----------------------------------------------
    // This is the case the tool was missing: the response that carried the link is long gone.
    await page.reload()
    const reloaded = page.locator('li', { hasText: email }).first()
    await reloaded.getByRole('button', { name: 'Show link' }).click()
    await expect(page.locator('p', { hasText: issued })).toBeVisible()

    // --- Resend keeps the same token --------------------------------------------------------
    // A fresh token would quietly kill the first link, so anyone who later found the original
    // email would be told their invite is invalid.
    await reloaded.getByRole('button', { name: 'Resend' }).click()
    // Waits for the outcome rather than for the button, so the token check below cannot run
    // before the action has. Delivery to example.com is refused by design, which is itself the
    // case worth seeing handled.
    await expect(page.getByText(/re-sent|didn.t send|not set up/i)).toBeVisible()
    expect(await tokenFor(email), 'resend must not mint a new token').toBe(issued)

    // --- A second invite to the same address supersedes the first ---------------------------
    await page.getByLabel('Their email').fill(email)
    await page.getByRole('button', { name: 'Send invite' }).click()
    // The old link is already on screen from Show link, so "a link is visible" would pass
    // instantly and race the write. Wait for the displayed link to actually change.
    await expect(page.locator('p', { hasText: '/onboard/' })).not.toContainText(issued)

    const superseded = (await query.query(
      `SELECT status FROM invite_links WHERE email = $1 AND token = $2`,
      [email, issued],
    )) as { status: string }[]
    expect(superseded[0]?.status, 'two live links for one person is the bug').toBe('expired')

    const reissued = await tokenFor(email)
    expect(reissued).not.toBe(issued)

    // The old link is dead from the provider's side too, not merely marked dead in a table.
    await page.goto(`/onboard/${issued}`)
    await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0)

    // --- Revoke ------------------------------------------------------------------------------
    await page.goto('/app/admin/tools')
    await page
      .locator('li', { hasText: email })
      .first()
      .getByRole('button', { name: 'Revoke' })
      .click()
    await expect(page.getByText(/no longer works/i)).toBeVisible()

    await page.goto(`/onboard/${reissued}`)
    await expect(page.getByRole('button', { name: 'Activate account' })).toHaveCount(0)
  })

  test('an email that already has an account is refused', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const rows = (await query.query(
      `SELECT email FROM providers ORDER BY email LIMIT 1`,
    )) as { email: string }[]
    const existing = rows[0]?.email
    expect(existing, 'no providers exist to test against').toBeTruthy()

    await page.goto('/app/admin/tools')
    await page.getByLabel('Their email').fill(existing)
    await page.getByRole('button', { name: 'Send invite' }).click()

    // Refused rather than issued-and-broken: the acceptance path will not create a second
    // provider for one email, so that token could never be used by anyone.
    await expect(page.getByText(/already has an account/i)).toBeVisible()

    const issued = (await query.query(
      `SELECT count(*)::int AS n FROM invite_links WHERE email = $1 AND status = 'pending'`,
      [existing],
    )) as { n: number }[]
    expect(issued[0]?.n, 'a dead-on-arrival invite was created anyway').toBe(0)
  })
})
