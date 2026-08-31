import { expect, test } from '@playwright/test'

// Photographing the laser, end to end.
//
// The unit tests cover when to ask and what is allowed in; none of them stores a byte. This is
// the only thing that exercises the actual path — downscale in the browser, upload through the
// server action, into a PRIVATE blob store, and back out through an authenticated route.
//
// Two real bugs got through everything else and were caught here: `put` was called with public
// access on a private store, and the read used a plain fetch of a URL that a private store
// refuses. Both type-checked, both passed the unit tests, both would have shipped.
//
// Skipped when storage is not configured rather than failing. A contributor without a blob token
// should see the rest of the suite pass, not a wall of red about a service they have not set up.

const CONFIGURED = Boolean(process.env.BLOB_READ_WRITE_TOKEN)

test.describe('equipment checks', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'desktop journey only')

  test('a photo is stored, served to an admin, and refused to a stranger', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')
    test.skip(!CONFIGURED, 'BLOB_READ_WRITE_TOKEN is not set — photo storage is not configured')
    test.setTimeout(120_000)

    const provider = await browser.newContext({ storageState: 'e2e/.auth/provider.json' })
    const page = await provider.newPage()

    // 'ZZ E2E ' is the prefix the teardown sweeps. A different one leaves a booking, a photo
    // and a blob behind on every run.
    const clientName = `ZZ E2E Equip ${Date.now()}`
    const day = new Date()
    day.setDate(day.getDate() + 30)
    const date = day.toISOString().slice(0, 10)

    await page.goto(`/app/book?month=${date.slice(0, 7)}&date=${date}`)

    // Named separately from the gates, because the equipment agreement blocks the form the same
    // way and renders the same h1 above it — so without this the run fails on a missing time
    // slot, which says nothing about the cause.
    await expect(
      page.getByRole('heading', { name: 'Photographing the laser' }),
      'the seeded provider has not accepted the equipment policy — run npm run dev:e2e-credentials',
    ).toHaveCount(0)

    const slot = page.locator('button', { hasText: /^\d{1,2}:\d{2} (AM|PM)$/ }).first()
    await expect(slot).toBeVisible()
    await slot.click()
    await page.getByLabel('Name', { exact: true }).fill(clientName)
    await page.getByRole('button', { name: 'Book appointment' }).click()
    await expect(page).toHaveURL(/\/app\/appointments\?booked=/)

    const bookingId = new URL(page.url()).searchParams.get('booked')!

    // The prompt only appears around the session, so the booking is moved into that window. A
    // test that booked for right now would be fighting the laser's real availability.
    await moveIntoWindow(bookingId)

    await page.goto('/app/appointments?status=upcoming')
    const card = page.locator('li', { hasText: clientName }).first()
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: /Photograph the laser to start/i }).click()
    await card.locator('input[type="file"]').setInputFiles('e2e/fixtures/laser.jpg')
    await card.getByLabel(/Anything worth saying/i).fill('ZZ probe — handpiece cradle chipped')
    await card.getByRole('checkbox').check()
    await card.getByRole('button', { name: 'Save photo' }).click()

    await expect(card.getByText(/Melanite has been told/i)).toBeVisible({ timeout: 45_000 })
    await provider.close()

    // Keoni's side: the flag first, and the photo must actually DECODE — a broken <img> is
    // present and visible, which is exactly how the private-read bug looked.
    const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' })
    const adminPage = await admin.newPage()
    await adminPage.goto('/app/admin/equipment')

    await expect(adminPage.getByText(/handpiece cradle chipped/i).first()).toBeVisible()
    const img = adminPage.locator('img').first()
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 30_000,
        message: 'the photo did not decode — the private read is broken',
      })
      .toBeGreaterThan(0)

    const src = await img.getAttribute('src')
    await admin.close()

    // The whole reason the store is private and reads go through our own route.
    const anon = await browser.newContext()
    const res = await anon.request.get(src!)
    expect(res.status(), 'an unauthenticated request was served a photo').toBe(401)
    await anon.close()
  })
})

/** Moves a booking into the window where checks are prompted.
 *
 *  Done in the database because the alternative is booking into a slot that is open right now,
 *  which depends on laser hours and on whatever else is booked today — a test that fails at 8pm
 *  for reasons that have nothing to do with photographs.
 */
async function moveIntoWindow(bookingId: string): Promise<void> {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL!)
  await sql.query(
    `UPDATE bookings
        SET start_time = now() - interval '15 minutes',
            end_time   = now() + interval '45 minutes'
      WHERE id = $1`,
    [bookingId],
  )
}
