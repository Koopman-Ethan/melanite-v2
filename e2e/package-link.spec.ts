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

    // Pick a service, then DERIVE the total from what it actually costs.
    //
    // This used to hardcode $600 for three sessions at $200 and select the service by
    // position. Both assumptions were about the seed data rather than about the feature: a
    // fresh import changes the prices, and grouping the dropdown into <optgroup>s changed what
    // sits at index 1. Neither is a product change, and neither should fail this test.
    //
    // The invariant being tested is the real one — the line total must match the package price
    // to the cent or the form refuses — so read the price and build a total that satisfies it.
    await page.getByRole('combobox').first().selectOption({ index: 1 })
    await page.getByLabel('Qty').fill('3')

    const perSession = Number(await page.getByLabel('Per session').inputValue())
    expect(perSession, 'the line did not inherit the provider’s price').toBeGreaterThan(0)
    await page.getByLabel('Total price').fill((perSession * 3).toFixed(2))

    await expect(page.getByText(/matches/)).toBeVisible()

    await page.getByRole('button', { name: 'Create package' }).click()
    await expect(existing).toBeVisible()
  }

  const card = page.locator('li').filter({ has: existing })

  // Read the price off the card rather than assuming it. The template may have been built by an
  // earlier run against different seed data, and the client-facing assertions below have to
  // match what this package actually costs — not what it cost the day the test was written.
  const priceText = await card.getByText(/^\$[\d,]+\.\d{2}$/).first().innerText()
  const packagePrice = Number(priceText.replace(/[$,]/g, ''))
  expect(packagePrice, 'the package card showed no price').toBeGreaterThan(0)

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
  await expect(clientPage.getByText(priceText).first()).toBeVisible()

  // Cherry appears beside the card option, not behind it — but only above its $200 floor, so
  // the assertion follows the actual price rather than assuming this package clears it.
  const cherry = clientPage.getByRole('link', { name: /Cherry/ })
  if (packagePrice >= 200) {
    await expect(cherry, `financing was hidden on a $${packagePrice} package`).toBeVisible()
  } else {
    await expect(
      cherry,
      `financing was offered on a $${packagePrice} package, below Cherry's floor`,
    ).toHaveCount(0)
  }

  await client.close()
})
