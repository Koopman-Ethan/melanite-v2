import { test as setup, expect } from '@playwright/test'

// Signs in once per role and saves the session, so the accessibility specs do not each pay for
// a login. Uses the real form rather than minting a cookie: if signing in breaks, every
// dependent test should fail loudly rather than sail past on a hand-made session.
//
// Credentials come from the environment. Committing them would put working logins for a real
// system in a public repository, and dev passwords have a way of surviving into production.

const PROVIDER_STATE = 'e2e/.auth/provider.json'
const ADMIN_STATE = 'e2e/.auth/admin.json'

async function signIn(
  page: import('@playwright/test').Page,
  email: string | undefined,
  password: string | undefined,
  role: string,
) {
  if (!email || !password) {
    throw new Error(
      `Missing E2E credentials for ${role}. Set E2E_${role.toUpperCase()}_EMAIL and ` +
        `E2E_${role.toUpperCase()}_PASSWORD in .env.local.`,
    )
  }

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Landing anywhere under /app means the session took. Asserting it here is what turns a bad
  // password into "login failed" rather than twelve confusing accessibility failures.
  await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 15_000 })
}

setup('authenticate as provider', async ({ page }) => {
  await signIn(page, process.env.E2E_PROVIDER_EMAIL, process.env.E2E_PROVIDER_PASSWORD, 'provider')
  await page.context().storageState({ path: PROVIDER_STATE })
})

setup('authenticate as admin', async ({ page }) => {
  await signIn(page, process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD, 'admin')
  await page.context().storageState({ path: ADMIN_STATE })
})
