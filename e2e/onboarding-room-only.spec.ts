import { randomBytes } from 'node:crypto'

import { expect, test } from '@playwright/test'

import '../envConfig'

// The other kind of provider: somebody who only rents the room.
//
// They bring their own clients and bill them directly, so Melanite never handles their client
// money. That removes two of the six setup steps — there is no share to pay them, so no Connect
// account, and the laser service menu describes nothing they do — and replaces the medical
// director question with a different one.
//
// The path is the risk here. Skipping steps means `onboardingStep` no longer lines up with
// "the next screen", and getting that wrong strands somebody on a step they have finished with
// nowhere legal to go. That is what this walks.

const OUT =
  'C:/Users/ethan/AppData/Local/Temp/claude/C--Users-ethan-Documents-GIT-melanite-v2/f3a46a8e-0ac0-40cb-b47b-781c667cfdef/scratchpad/'

async function sql() {
  const { neon } = await import('@neondatabase/serverless')
  return neon(process.env.DATABASE_URL!)
}

test.describe('room-only onboarding', () => {
  test('a room renter skips Connect and services, and declares what they perform', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const token = randomBytes(24).toString('base64url')
    const email = `zz.onboard.room.${Date.now()}@example.com`

    await query.query(
      `INSERT INTO invite_links (email, token, status, expires_at, invited_by_admin_id)
       VALUES ($1, $2, 'pending', now() + interval '7 days',
               (SELECT id FROM providers WHERE role IN ('platform_owner','developer')
                 ORDER BY email LIMIT 1))`,
      [email, token],
    )

    // --- password ---------------------------------------------------------------------------
    await page.goto(`/onboard/${token}`)
    const password = `E2e-Room-${randomBytes(6).toString('hex')}!`
    await page.getByLabel('Create password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password').fill(password)
    await page.getByRole('button', { name: 'Activate account' }).click()

    // --- profile, where the fork happens ----------------------------------------------------
    await expect(page).toHaveURL(/\/onboarding\/profile/)
    await page.getByLabel('First name').fill('Zzroom')
    await page.getByLabel('Last name').fill('Renter')
    await page.getByLabel('Phone number').fill('208-555-0177')
    await page.getByLabel('Professional credentials').fill('LE')

    await page.getByRole('button', { name: /Renting the room only/ }).click()
    await page.screenshot({ path: `${OUT}room-1-profile.png`, fullPage: true })
    await page.getByRole('button', { name: /continue/i }).click()

    // --- licence — still required. A room renter is a clinician on the premises. -------------
    await expect(page).toHaveURL(/\/onboarding\/license/)
    await expect(page.getByText('Step 3 of 4')).toBeVisible()
    await page.getByLabel('License number').fill('LE-E2E-0002')
    await page.getByLabel('License state').fill('Idaho')
    await page.getByLabel('License expiry').fill('2099-12-31')
    await page.getByLabel('Malpractice insurance provider').fill('NSO')
    await page.getByRole('button', { name: /continue/i }).click()

    // --- STRAIGHT TO THE DECLARATION, skipping Connect ---------------------------------------
    // The step that would strand them. Their next step is 5 while `onboardingStep` says 3, so a
    // guard comparing raw numbers sends them to a Connect step they can never complete.
    await expect(
      page,
      'a room renter was sent to the Connect step, which does not apply to them',
    ).toHaveURL(/\/onboarding\/director/)
    await expect(page.getByRole('heading', { name: /What will you be performing/i })).toBeVisible()
    await page.screenshot({ path: `${OUT}room-2-declare.png`, fullPage: true })

    // The rail has to tell the truth about a path that is four steps long, not six.
    //
    // This is the half the first version of this test missed: the flow worked, and the sidebar
    // said "Step 5 of 6", ticked off a Connect Stripe step nobody did, and promised a Select
    // Services step that never arrives. `onboardingStep` stays canonical; the DISPLAY counts
    // only what applies.
    await expect(page.getByText('Step 4 of 4')).toBeVisible()
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Connect Stripe' }),
      'the rail offered a Connect step to somebody who has no share to be paid',
    ).toHaveCount(0)
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Select Services' }),
      'the rail promised a services step that never comes — this screen is the last one',
    ).toHaveCount(0)

    // Declaring a supervised procedure warns before they commit, not after.
    await page.getByRole('button', { name: 'Injections' }).click()
    await expect(page.getByText(/A medical director is required/i)).toBeVisible()
    await page.screenshot({ path: `${OUT}room-3-needs-director.png`, fullPage: true })

    // Change to none: the consequence changes with it.
    await page.getByRole('button', { name: 'None of these' }).click()
    await expect(page.getByText(/No medical director needed/i)).toBeVisible()

    await page.getByRole('button', { name: 'Finish setup' }).click()

    // --- done, WITHOUT a services step -------------------------------------------------------
    await expect(page).toHaveURL(/\/onboarding\/done/)
    await page.screenshot({ path: `${OUT}room-4-done.png`, fullPage: true })

    // --- and the record ----------------------------------------------------------------------
    const [row] = (await query.query(
      `SELECT status, practice_type, room_procedures, room_procedures_declared_at,
              room_rental_enabled, booking_enabled, stripe_account_id
         FROM providers WHERE email = $1`,
      [email],
    )) as Record<string, unknown>[]

    // Active, or they finish setup and cannot sign in to anything — there is no step 6 to flip
    // it for them.
    expect(row.status, 'a room renter must end up active').toBe('active')
    expect(row.practice_type).toBe('room_only')
    expect(row.room_procedures).toEqual([])
    // Timestamped, so "declared nothing" is distinguishable from "never asked".
    expect(row.room_procedures_declared_at).not.toBeNull()
    // Nothing supervised declared, so the room is open.
    expect(row.room_rental_enabled).toBe(true)
    // And the laser is not, which is the whole point.
    expect(row.booking_enabled, 'a room renter must not be cleared to book the laser').toBe(false)
    // No Connect account was ever created — there is no share to pay them.
    expect(row.stripe_account_id).toBeNull()

    await query.query(`DELETE FROM sessions WHERE provider_id IN
      (SELECT id FROM providers WHERE email = $1)`, [email])
    await query.query(`DELETE FROM providers WHERE email = $1`, [email])
    await query.query(`DELETE FROM invite_links WHERE email = $1`, [email])
  })

  test('declaring a supervised procedure closes the room until a director is on file', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'phone', 'workflow covered once, on desktop')

    const query = await sql()
    const token = randomBytes(24).toString('base64url')
    const email = `zz.onboard.room2.${Date.now()}@example.com`

    await query.query(
      `INSERT INTO invite_links (email, token, status, expires_at, invited_by_admin_id)
       VALUES ($1, $2, 'pending', now() + interval '7 days',
               (SELECT id FROM providers WHERE role IN ('platform_owner','developer')
                 ORDER BY email LIMIT 1))`,
      [email, token],
    )

    await page.goto(`/onboard/${token}`)
    const password = `E2e-Room-${randomBytes(6).toString('hex')}!`
    await page.getByLabel('Create password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password').fill(password)
    await page.getByRole('button', { name: 'Activate account' }).click()

    await page.getByLabel('First name').fill('Zzroom')
    await page.getByLabel('Last name').fill('Injector')
    await page.getByLabel('Phone number').fill('208-555-0178')
    await page.getByLabel('Professional credentials').fill('RN')
    await page.getByRole('button', { name: /Renting the room only/ }).click()
    await page.getByRole('button', { name: /continue/i }).click()

    await page.getByLabel('License number').fill('RN-E2E-0003')
    await page.getByLabel('License state').fill('Idaho')
    await page.getByLabel('License expiry').fill('2099-12-31')
    await page.getByLabel('Malpractice insurance provider').fill('NSO')
    await page.getByRole('button', { name: /continue/i }).click()

    await page.getByRole('button', { name: 'Microneedling' }).click()
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page).toHaveURL(/\/onboarding\/done/)

    const [row] = (await query.query(
      `SELECT status, room_procedures, room_rental_enabled FROM providers WHERE email = $1`,
      [email],
    )) as Record<string, unknown>[]

    // They finish setup — refusing to let somebody create an account is a worse answer than
    // letting them in and withholding the one thing that needs supervision.
    expect(row.status).toBe('active')
    expect(row.room_procedures).toEqual(['microneedling'])
    expect(
      row.room_rental_enabled,
      'the room must stay closed while supervision is owed — Melanite owns it',
    ).toBe(false)

    await query.query(`DELETE FROM sessions WHERE provider_id IN
      (SELECT id FROM providers WHERE email = $1)`, [email])
    await query.query(`DELETE FROM providers WHERE email = $1`, [email])
    await query.query(`DELETE FROM invite_links WHERE email = $1`, [email])
  })
})
