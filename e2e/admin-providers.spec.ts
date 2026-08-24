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
    // provider has no license on file.
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

    // This provider has NO license on file. That used to pass the gate — a null expiry is not
    // an expired one — so the honest sentence was "nothing stops them". `hasCurrentLicense`
    // closed that, and the copy moved with it. Asserting the true sentence in both directions
    // is what stops the page and the gate drifting apart again.
    await expect(row.getByText(/no license on file/i)).toBeVisible()
    await expect(row.getByText(/license gate blocks them/i)).toBeVisible()
    await expect(row.getByText(/nothing stops them/i)).toHaveCount(0)

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

    // Someone at step 2 has no license on file yet — step 3 has not happened. The toggle is
    // disabled, and the action refuses independently, because a disabled input is not a rule.
    await expect(row.getByLabel('Can book clients')).toBeDisabled()

    const state = (await query.query(`SELECT booking_enabled FROM providers WHERE id = $1`, [
      rows[0].id,
    ])) as Record<string, boolean>[]
    expect(state[0].booking_enabled).toBe(false)

    await query.query(`DELETE FROM providers WHERE id = $1`, [rows[0].id])
  })
})

test.describe('room-only providers on the roster', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'workflow, covered once')

  // Melanite cannot see inside the rented room, so a room renter's declaration of what they
  // perform is the ONLY basis for the room-rental toggle. That makes the roster the place where
  // the toggle either explains itself or becomes a switch somebody flips back on to "fix" it.

  test('shows what they declared, and warns before the toggle undoes it', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const email = `zz.onboard.roomroster.${Date.now()}@example.com`

    // Declared injections, no director on file — so onboarding closed the room.
    const rows = (await query.query(
      `INSERT INTO providers (email, password_hash, requires_password_reset, first_name,
                              last_name, role, status, onboarding_step, booking_enabled,
                              room_rental_enabled, practice_type, room_procedures,
                              room_procedures_declared_at)
       VALUES ($1, 'x', true, 'Zzroomonly', 'Subject', 'provider', 'active', 5, false,
               false, 'room_only', ARRAY['injections'], now())
       RETURNING id`,
      [email],
    )) as { id: string }[]
    const id = rows[0].id

    await page.goto('/app/admin/providers')
    const row = page.locator('li', { hasText: 'Zzroomonly Subject' })
    await expect(row).toBeVisible()

    await expect(row, 'nothing said this provider only rents the room').toContainText('room only')
    await expect(row, 'the declaration was not shown').toContainText('injections')

    // The line that stops the toggle being flipped back on blind.
    await expect(
      row,
      'no warning that turning the room back on permits unsupervised injections',
    ).toContainText(/no medical director on file/i)

    // Payouts are not a task for somebody with no share to be paid.
    await expect(
      row,
      'the roster asked a room renter for a Stripe account they will never be paid through',
    ).not.toContainText('no Stripe account')

    // --- moving them to the laser --------------------------------------------------------
    await row.getByRole('button', { name: 'Move to laser' }).click()
    await expect(page.getByText(/asked to connect Stripe and pick services/i)).toBeVisible()

    const [after] = (await query.query(
      `SELECT practice_type, status, onboarding_step FROM providers WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]

    // Flipping the column alone would leave somebody marked as a laser provider with no way to
    // be paid — a failed payout weeks later. They go back to setup and walk the two steps.
    expect(after.practice_type).toBe('laser')
    expect(after.status, 'moved to laser without being asked for Stripe or services').toBe(
      'pending',
    )
    expect(after.onboarding_step).toBe(3)

    await query.query(`DELETE FROM providers WHERE id = $1`, [id])
  })

  test('a clean declaration reads as settled, not as an outstanding task', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const email = `zz.onboard.roomclean.${Date.now()}@example.com`
    const rows = (await query.query(
      `INSERT INTO providers (email, password_hash, requires_password_reset, first_name,
                              last_name, role, status, onboarding_step, booking_enabled,
                              room_rental_enabled, practice_type, room_procedures,
                              room_procedures_declared_at)
       VALUES ($1, 'x', true, 'Zzroomclean', 'Subject', 'provider', 'active', 5, false,
               true, 'room_only', ARRAY[]::text[], now())
       RETURNING id`,
      [email],
    )) as { id: string }[]
    const id = rows[0].id

    await page.goto('/app/admin/providers')
    const row = page.locator('li', { hasText: 'Zzroomclean Subject' })

    await expect(row).toContainText('nothing needing supervision')
    // A director they do not need must not read as a missing one — a warning that is wrong
    // most of the time is one nobody reads.
    await expect(row).toContainText('Medical director: not required')
    await expect(row).not.toContainText(/no medical director on file/i)

    await query.query(`DELETE FROM providers WHERE id = $1`, [id])
  })
})
