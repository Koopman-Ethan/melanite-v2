import { expect, test } from '@playwright/test'

// A student financing a course, and Keoni finding out.
//
// The hand-off is the whole risk here. The student leaves for Cherry, gets a decision days
// later, and Cherry pays Melanite by ACH after that — no webhook ever arrives. So the only
// things standing between "applied" and "lost" are the seat hold and the badge on the course
// page, and neither is exercised by any other test.
//
// Cherry's own site is not under test. The click navigates away; what this asserts is what was
// left behind.

// Keoni's half needs an admin session; the student's half deliberately gets a fresh anonymous
// context, because a prospective student has no account and that is the point.
test.use({ storageState: 'e2e/.auth/admin.json' })

test('applying through Cherry reserves the seat and shows up for Keoni', async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name === 'phone', 'workflow covered once, on desktop')

  const email = `zz.cherry.${Date.now()}@example.com`

  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } })

  // Block ONLY Cherry's domain. The click navigates off-site and the default click waits for
  // that page to load, so without this the test waits on somebody else's servers.
  //
  // Scoped to the one host deliberately: an earlier version intercepted `**/*` and continued
  // everything else, which silently broke the server action's own POST and created no enrolment
  // at all — a test that failed for a reason that had nothing to do with the feature.
  await anon.route('**://pay.withcherry.com/**', (route) => route.abort())

  const student = await anon.newPage()
  await student.goto('/training')

  const cherryButton = student.getByRole('button', { name: /Cherry/ })
  if ((await cherryButton.count()) === 0) {
    await anon.close()
    test.skip(true, 'no course open for enrolment, or no Cherry link configured')
  }

  await student.getByLabel('First name').fill('ZZ Cherry')
  await student.getByLabel('Last name').fill('Applicant')
  await student.getByLabel('Email').fill(email)
  await student.getByLabel('Phone').fill('2085550199')
  await student.getByLabel(/[Ll]icense number/).fill('RN-CH-1')

  await cherryButton.click()
  // The action has to finish and write the row; the navigation it triggers is aborted above.
  await student.waitForTimeout(4000)
  await anon.close()

  // --- Keoni's side ------------------------------------------------------------------------
  await page.goto('/app/admin/training')
  await page.locator('a[href*="/app/admin/training/"]').first().click()

  const row = page.locator('li').filter({ hasText: email })
  await expect(row, 'the applicant must appear on the course page').toBeVisible({
    timeout: 15000,
  })

  // The badge IS the feature. Without it a financing application is indistinguishable from an
  // abandoned form, which is exactly the state this replaces.
  await expect(
    row.getByText(/Cherry · applied/),
    'no Cherry badge — the hand-off was recorded nowhere Keoni can see it',
  ).toBeVisible()

  // And emphatically NOT paid. They have applied for financing, not been approved for it.
  await expect(row.getByText(/UNPAID/i)).toBeVisible()
})
