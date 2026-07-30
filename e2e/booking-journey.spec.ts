import { expect, test } from '@playwright/test'

// The journey that carries the money: a provider books, the client gets a payment link, the
// link shows the right amount, and the states around it behave.
//
// Runs on desktop only. It is a workflow test, not a layout one — the accessibility suite
// already exercises every page at phone width.
//
// What it deliberately does NOT do is complete a card payment. Entering card details is not
// something to automate here, and the part after "client presses pay" is Stripe's, already
// verified once by hand end to end. What this covers is everything up to that point, which is
// where this app's own logic lives.

test.use({ storageState: 'e2e/.auth/provider.json' })

/** A far-future date, so the test never collides with real appointments or with itself. */
function farFutureDate(offsetDays: number): string {
  const at = new Date(Date.UTC(2099, 0, 1))
  at.setUTCDate(at.getUTCDate() + offsetDays)
  return at.toISOString().slice(0, 10)
}

test.describe('booking to payment link', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'desktop journey only')

  test('a booking produces a payment link the provider can actually send', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    // Unique per run, so repeated runs never fight over the same slot.
    const date = farFutureDate(testInfo.workerIndex * 3 + (Date.now() % 900))
    const clientName = `ZZ E2E ${Date.now()}`

    const month = date.slice(0, 7)
    await page.goto(`/app/book?month=${month}&date=${date}`)

    // A provider who cannot book sees the gates instead of the form. That is a real state, and
    // failing here with a clear message beats a confusing timeout on a missing field.
    await expect(
      page.getByRole('heading', { name: 'Book laser time' }),
      'provider cannot reach the booking form — check the seeded account still passes the gates',
    ).toBeVisible()

    // Pick the first open time.
    const slot = page.locator('button', { hasText: /^\d{1,2}:\d{2} (AM|PM)$/ }).first()
    await expect(slot).toBeVisible()
    await slot.click()

    await page.getByLabel('Name', { exact: true }).fill(clientName)
    await page.getByLabel('Email').fill('zz.e2e@example.com')

    await page.getByRole('button', { name: 'Book appointment' }).click()

    // Lands on appointments with the confirmation banner — the thing that was missing entirely
    // until recently, when the link was created and shown to nobody.
    await expect(page).toHaveURL(/\/app\/appointments\?booked=/)
    await expect(page.getByText(`Booked for ${clientName}`)).toBeVisible()

    // The link must be present and copyable, whether or not the email went out.
    const link = page.locator('code', { hasText: '/pay/' })
    await expect(link).toBeVisible()

    const url = (await link.textContent())?.trim() ?? ''
    expect(url, 'no payment link was shown').toMatch(/\/pay\/[A-Za-z0-9_-]+$/)

    // And the appointment itself is on the list.
    await expect(page.getByText(clientName).first()).toBeVisible()

    // --- Now the client's side of the same link -------------------------------------------
    const token = url.split('/pay/')[1]
    const clientPage = await page.context().newPage()
    // A fresh context would be more faithful, but the pay page is public — proving it renders
    // without depending on the provider's session is the accessibility suite's job, which loads
    // /pay with no cookie at all.
    await clientPage.goto(`/pay/${token}`)

    await expect(clientPage.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(clientPage.getByText(clientName)).toBeHidden() // the client sees the SERVICE, not their own name as a heading
    await expect(clientPage.getByText('Total')).toBeVisible()

    // The consent language must name the fees. It is the artifact that makes an off-session
    // charge defensible, so its absence is a correctness failure, not a copy nit.
    await expect(clientPage.getByText(/Keep my card on file/)).toBeVisible()
    await expect(clientPage.getByText(/do not attend this appointment/)).toBeVisible()

    // AND THE PAYMENT ACTUALLY STARTS.
    //
    // This spec used to stop at "the page renders", which is how appdev reached a demo unable
    // to take a single payment. Every provider carried a LIVE Connect account id from the v1
    // migration; a test key cannot see one, so `transfer_data.destination` failed and the
    // client got "Could not start the payment. Try again shortly." — advice that would never
    // come true however many times they tried.
    //
    // Rendering a checkout page proves nothing about whether money can move. Creating the
    // PaymentIntent is the first step that touches Stripe with the provider's account id, so
    // it is the first step that can catch this. No card is entered and nothing is charged.
    await clientPage.getByRole('button', { name: /Continue to payment/ }).click()

    // Wait for one of the two outcomes before judging either. Asserting the error is absent on
    // its own would pass instantly — it is absent for the whole round trip, right up until it
    // is not — so it has to be a race between the success signal and the failure signal.
    const cardFrame = clientPage.locator('iframe[name^="__privateStripeFrame"]').first()
    const failure = clientPage.getByText(/Could not start the payment/)

    await expect(async () => {
      const started = (await cardFrame.count()) > 0
      const failed = (await failure.count()) > 0
      expect(
        started || failed,
        'neither the card fields nor an error appeared — the intent request never resolved',
      ).toBe(true)
    }).toPass({ timeout: 20_000 })

    await expect(
      failure,
      'PaymentIntent creation failed. Usually a provider Stripe account the current key cannot ' +
        'see: dev data carries LIVE Connect ids from the v1 migration and a test key gets 403. ' +
        'Run scripts/dev-connect-accounts.ts.',
    ).toHaveCount(0)

    // Stripe's own iframe only mounts once the intent exists, so this is the positive proof
    // that money could move — not merely that a page rendered.
    await expect(cardFrame).toBeAttached()

    await clientPage.close()

    // --- Clean up ---------------------------------------------------------------------------
    // Cancelling through the UI, not the database: it exercises the cancel path and leaves the
    // slot genuinely free for the next run.
    await page.goto('/app/appointments?status=upcoming')
    const card = page.locator('li', { hasText: clientName })
    await card.getByRole('button', { name: 'Cancel' }).click()
    await card.getByRole('button', { name: 'Yes, cancel' }).click()

    // The card LEAVES the list rather than showing a success message — this view is filtered to
    // upcoming, and a cancelled appointment is no longer one. Asserting on the message was
    // wrong: the element carrying it is the one being removed.
    await expect(page.locator('li', { hasText: clientName })).toHaveCount(0)

    // And it really is cancelled, not merely filtered out of sight.
    await page.goto('/app/appointments?status=cancelled')
    await expect(page.getByText(clientName).first()).toBeVisible()
  })

  test('a token that does not exist says so plainly', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'covered once')

    await page.goto('/pay/definitely-not-a-real-token')
    await expect(page.getByText('Payment link not found')).toBeVisible()
    // Never a stack trace, never a blank page — a client holding a bad link needs to know to ask
    // their provider for a new one.
    await expect(page.getByText(/ask your provider/i)).toBeVisible()
  })
})
