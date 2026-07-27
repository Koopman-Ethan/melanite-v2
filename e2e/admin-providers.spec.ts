import { expect, test } from '@playwright/test'

import '../envConfig'

// The provider roster: who may take clients, and who may rent the room.
//
// `booking_enabled` is the last step of onboarding and was being done by hand against the
// database, because nothing in the app could do it. It decides whether someone may treat a
// client, so it is worth more than a checkbox and a hope.

test.use({ storageState: 'e2e/.auth/admin.json' })

async function sql() {
  const { neon } = await import('@neondatabase/serverless')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set — the e2e suite needs a real database')
  return neon(url)
}

test.describe('provider access', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'workflow, covered once')

  test('booking and room rental can be granted and revoked', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()

    // A throwaway rather than a real provider: this test flips access on and off, and doing
    // that to somebody's live account for the sake of a test is not acceptable even briefly.
    const email = `zz.onboard.roster.${Date.now()}@example.com`
    const rows = (await query.query(
      `INSERT INTO providers (email, password_hash, requires_password_reset, first_name,
                              last_name, role, status, onboarding_step, booking_enabled,
                              room_rental_enabled)
       VALUES ($1, 'x', true, 'Zzroster', 'Subject', 'provider', 'active', 6, false, false)
       RETURNING id`,
      [email],
    )) as { id: string }[]
    const id = rows[0].id

    await page.goto('/app/admin/providers')
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()

    const row = page.locator('li', { hasText: 'Zzroster Subject' })
    await expect(row).toBeVisible()

    // Context is shown before the controls — the flip is a judgement about readiness, and this
    // provider has no licence on file.
    await expect(row).toContainText('none on file')

    // --- Grant ------------------------------------------------------------------------------
    const booking = row.getByLabel('Can book clients')
    await expect(booking).not.toBeChecked()
    await booking.check()
    await expect(page.getByText(/booking enabled for zzroster/i)).toBeVisible()

    let state = (await query.query(
      `SELECT booking_enabled, room_rental_enabled FROM providers WHERE id = $1`,
      [id],
    )) as Record<string, boolean>[]
    expect(state[0].booking_enabled, 'the grant never reached the database').toBe(true)

    // Granting booking does not quietly grant everything else.
    expect(state[0].room_rental_enabled, 'room rental changed on its own').toBe(false)

    // Booking on with no licence is still blocked by the licence gate, and the page says so
    // rather than letting an admin believe the provider is now good to go.
    await expect(row.getByText(/licence gate will block them/i)).toBeVisible()

    // --- Revoke -----------------------------------------------------------------------------
    await row.getByLabel('Can book clients').uncheck()
    await expect(page.getByText(/booking disabled for zzroster/i)).toBeVisible()

    state = (await query.query(`SELECT booking_enabled FROM providers WHERE id = $1`, [
      id,
    ])) as Record<string, boolean>[]
    expect(state[0].booking_enabled).toBe(false)

    // --- Room rental is independent ----------------------------------------------------------
    await row.getByLabel('Can rent the room').check()
    await expect(page.getByText(/room rental enabled/i)).toBeVisible()
    state = (await query.query(
      `SELECT booking_enabled, room_rental_enabled FROM providers WHERE id = $1`,
      [id],
    )) as Record<string, boolean>[]
    expect(state[0].room_rental_enabled).toBe(true)
    expect(state[0].booking_enabled, 'room rental leaked into booking').toBe(false)

    await query.query(`DELETE FROM providers WHERE id = $1`, [id])
  })

  test('a provider still in setup cannot be granted booking', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const email = `zz.onboard.roster.pending.${Date.now()}@example.com`
    const rows = (await query.query(
      `INSERT INTO providers (email, password_hash, requires_password_reset, first_name,
                              last_name, role, status, onboarding_step, booking_enabled)
       VALUES ($1, 'x', true, 'Zzpending', 'Subject', 'provider', 'pending', 2, false)
       RETURNING id`,
      [email],
    )) as { id: string }[]

    await page.goto('/app/admin/providers')
    const row = page.locator('li', { hasText: 'Zzpending Subject' })
    await expect(row).toContainText('still in setup')

    // Someone at step 2 has no licence on file yet — step 3 has not happened. The toggle is
    // disabled, and the action refuses independently, because a disabled input is not a rule.
    await expect(row.getByLabel('Can book clients')).toBeDisabled()

    const state = (await query.query(`SELECT booking_enabled FROM providers WHERE id = $1`, [
      rows[0].id,
    ])) as Record<string, boolean>[]
    expect(state[0].booking_enabled).toBe(false)

    await query.query(`DELETE FROM providers WHERE id = $1`, [rows[0].id])
  })
})
