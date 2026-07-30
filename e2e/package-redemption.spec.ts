import { expect, test } from '@playwright/test'

// Delivering a session a client has already paid for, and giving it back if it is cancelled.
//
// Two separate failures met here, and neither could be seen from the other end:
//
//   - `bookFromPackage` was complete, careful, unit-tested and called by NOTHING. A provider
//     could sell a package, take the money, and then had no way to book the sessions. The unit
//     test reimplemented the claim in raw SQL rather than invoking the action, so it passed
//     while the action itself referenced a `discount_pct` column that has never existed on
//     `bookings` — the INSERT could never have run.
//
//   - `isPackageRedemption` was false for every appointment ever, because a correlated
//     subquery rendered its columns unqualified and compared package_redemptions.booking_id to
//     package_redemptions.id. It decides which cancel is offered, so cancelling a redemption
//     took the ordinary path and the client's paid session was NOT returned.
//
// Booking then cancelling exercises both, and leaves the balance exactly as it was found.

test.use({ storageState: 'e2e/.auth/provider.json' })

/** "2 of 3" for the named service, read off the balance card. */
async function sessionsLeft(page: import('@playwright/test').Page, service: string) {
  await page.goto('/app/packages')
  // Scoped to the balances section: the template list above names the same services, and its
  // rows carry quantities that look enough like a session count to be read as one.
  const row = page
    .locator('section')
    .filter({ hasText: 'Client balances' })
    .locator('li')
    .filter({ hasText: service })
    .last()
  const text = await row.innerText()
  const match = /(\d+) of (\d+)/.exec(text)
  if (!match) throw new Error(`no session count for ${service} in: ${text}`)
  return { left: Number(match[1]), total: Number(match[2]) }
}

test('a prepaid session can be booked, and cancelling gives it back', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'workflow covered once, on desktop')

  await page.goto('/app/packages')
  const balances = page.locator('section').filter({ hasText: 'Client balances' })
  const bookable = balances.getByRole('button', { name: 'Book', exact: true })

  if ((await bookable.count()) === 0) {
    test.skip(true, 'no package balance with sessions left in this environment')
  }

  // The NEAREST li ancestor of the button. Filtering li by "contains a Book button" also
  // matches the whole balance card, and the card wins on document order — which reads the
  // client's name as the service and the wrong line's session count.
  const line = bookable.first().locator('xpath=ancestor::li[1]')
  const service = (await line.innerText()).split('\n')[0].trim()

  const before = await sessionsLeft(page, service)

  await balances.getByRole('button', { name: 'Book', exact: true }).first().click()
  await expect(page.getByText(/^Book .+ for /)).toBeVisible()

  // Three weeks out, so the laser is free and the date is comfortably valid.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
    new Date(Date.now() + 21 * 864e5),
  )
  await page.locator('input[type="date"]').fill(date)

  const slot = page.locator('button[aria-pressed]').first()
  await expect(slot, 'no free laser time three weeks out — is the calendar full?').toBeVisible({
    timeout: 15000,
  })
  await slot.click()
  await page.getByRole('button', { name: 'Book this session' }).click()
  await expect(page.getByText(/Session booked from the package/)).toBeVisible({ timeout: 15000 })

  const after = await sessionsLeft(page, service)
  expect(after.left, 'the session was not consumed').toBe(before.left - 1)

  // --- and on the calendar, where it must NOT look like an ordinary paid booking ------------
  await page.goto('/app/appointments?status=upcoming')
  const forClient = page.locator('li').filter({ hasText: 'Clients Test' })
  // This client may have several appointments; only one of them is the redemption just made.
  const upcomingBefore = await forClient.count()
  await forClient.first().getByRole('button', { name: 'Cancel' }).click()

  // The wording IS the flag. This sentence only appears when isPackageRedemption is true, and
  // the button beside it is the one that returns the session.
  await expect(
    page.getByText(/return the session/),
    'cancel offered the ordinary path for a package redemption — isPackageRedemption is false, ' +
      'so cancelling would destroy a session the client paid for',
  ).toBeVisible()

  await page.getByRole('button', { name: 'Yes, cancel' }).click()

  // Wait for the cancellation to land before navigating. Reading the balance immediately
  // raced the server action and reported the pre-cancel count — a test failure describing a
  // bug that was not there, which is worse than no test.
  await expect(forClient).toHaveCount(upcomingBefore - 1)

  // Back exactly where it started. A redemption that could be cancelled without returning the
  // session would leave this one short.
  const restored = await sessionsLeft(page, service)
  expect(restored.left, 'the cancelled session was not returned to the client').toBe(before.left)
})
