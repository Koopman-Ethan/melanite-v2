import { expect, test } from '@playwright/test'

// Selling a package, end to end: build one, send the link, and open it as the client would.
//
// This path had a hole worth catching — `createPackageLink` and the whole `/pay/package`
// checkout existed and worked, and nothing in the app called either of them. A provider could
// not sell a package at all, which no unit test noticed because every piece passed on its own.
//
// The client half runs in a fresh browser context with no session. A payment link that only
// works for somebody already signed in is not a payment link.

const PACKAGE_NAME = 'ZZ E2E Package'
const CLIENT_NAME = 'ZZ E2E Cherry Client'

test.use({ storageState: 'e2e/.auth/provider.json' })

test('a provider can sell a package, and the client can pay for it', async ({ page, browser }) => {
  await page.goto('/app/packages')

  // Build it if a previous run left nothing behind. Templates are soft-deleted, never removed,
  // so this reuses one rather than accumulating a new one per run.
  const existing = page.getByRole('heading', { name: PACKAGE_NAME, exact: true })
  if ((await existing.count()) === 0) {
    await page.getByRole('button', { name: 'Build a package' }).click()
    await page.getByLabel('Name').fill(PACKAGE_NAME)
    await page.getByLabel('Total price').fill('600')

    // Three sessions at $200 — the sum has to match the total to the cent or the form refuses.
    await page.getByRole('combobox').first().selectOption({ index: 1 })
    await page.getByLabel('Qty').fill('3')
    await expect(page.getByText(/matches/)).toBeVisible()

    await page.getByRole('button', { name: 'Create package' }).click()
    await expect(existing).toBeVisible()
  }

  const card = page.locator('li').filter({ has: existing })
  await card.getByRole('button', { name: 'Send link' }).click()

  // No email on purpose: the link is handed back so it can be sent by text, which is how most
  // of these actually travel. Filling one in would send a real message from a test.
  await page.getByLabel('Client name').fill(CLIENT_NAME)
  await page.getByRole('button', { name: 'Create link' }).click()

  const url = await page.getByLabel('Payment link').inputValue()
  expect(url).toContain('/pay/package/')

  // It must now be visible as outstanding — a link the provider cannot see is a sale they have
  // to remember.
  await page.reload()
  const awaiting = page.locator('section').filter({ hasText: 'Awaiting payment' })
  // `.first()` because links with no email cannot be deduplicated — two clients who only gave a
  // phone number are not the same person, so `createPackageLink` deliberately does not merge
  // them, and repeated runs of this spec leave more than one.
  await expect(awaiting.getByText(CLIENT_NAME).first()).toBeVisible()

  // The client's view, with no session at all.
  const client = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const clientPage = await client.newPage()
  await clientPage.goto(url)

  await expect(clientPage.getByText(PACKAGE_NAME)).toBeVisible()
  await expect(clientPage.getByText('$600.00').first()).toBeVisible()

  // $600 is over Cherry's $200 floor, so financing is offered beside the card option rather
  // than behind it.
  await expect(clientPage.getByRole('link', { name: /Cherry/ })).toBeVisible()

  await client.close()
})
