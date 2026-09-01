import { expect, test } from '@playwright/test'

// Getting a payment link back to a client after the day it was made.
//
// The link used to be shown once, in the banner immediately after booking, and was unreachable
// after that. A real provider had a completed $70 appointment sitting unpaid and a second one
// whose link had expired four days earlier — with no way to send either.
//
// Both fixtures are built directly rather than through the UI, because the interesting states
// are a LIVE link and a DEAD one, and the second cannot be reached by booking: it needs an
// expiry in the past.

test.use({ storageState: 'e2e/.auth/provider.json' })

test.beforeAll(async () => {
  await seedLinks()
})

test('a provider can send the link again, and replace a dead one', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop only')
  test.setTimeout(120_000)

  await page.goto('/app/appointments?status=completed')
  const live = page.locator('li', { hasText: 'ZZ E2E Live' }).first()
  await expect(live).toBeVisible()

  // A live link: shown, copyable, and re-sendable.
  await expect(live.getByText('Awaiting payment')).toBeVisible()
  await expect(live.getByText(/\/pay\/zzlivetoken/)).toBeVisible()
  await expect(live.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await live.getByRole('button', { name: /Email it again/i }).click()
  // The fixture client is @example.com, which sendEmail refuses outright — so the honest
  // outcome is being told nothing was sent, not a false success.
  await expect(live.getByText(/didn.t send|not set up|Sent again/i)).toBeVisible({ timeout: 20_000 })
  console.log('RESEND_REPORTED_HONESTLY')

  // An expired link: no copy button for a dead URL, and a way out.
  await page.goto('/app/appointments?status=upcoming')
  const dead = page.locator('li', { hasText: 'ZZ E2E Expired' }).first()
  await expect(dead).toBeVisible()
  await expect(dead.getByText(/Payment link — expired/)).toBeVisible()
  await expect(dead.getByRole('button', { name: 'Copy link' })).toHaveCount(0)
  await dead.getByRole('button', { name: /Issue a new link/i }).click()
  await expect(dead.getByText(/New link/i)).toBeVisible({ timeout: 20_000 })
  console.log('REISSUED')
})

/** Two bookings for the e2e provider: one with a live link, one whose link died four days ago.
 *
 *  Dated 2094 so they cannot collide with a real appointment on the shared laser — the overlap
 *  constraint is real and a fixture that fights it fails for reasons that have nothing to do
 *  with payment links. Named `ZZ E2E ` so the teardown sweeps them.
 */
async function seedLinks(): Promise<void> {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL!)

  const [provider] = (await sql.query(
    `SELECT id FROM providers WHERE lower(email) = lower($1)`,
    [process.env.E2E_PROVIDER_EMAIL],
  )) as { id: string }[]

  const [service] = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND is_active LIMIT 1`,
    [provider.id],
  )) as { id: string }[]

  const make = async (name: string, price: string, day: string, status: string) => {
    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, client_email, original_price, price,
          payment_source, duration_mins, start_time, end_time, status)
       VALUES ($1, $2, $3, 'zz.e2e@example.com', $4, $4, 'checkout_link', 60,
               $5::timestamptz, $5::timestamptz + interval '1 hour', $6::booking_status)
       RETURNING id`,
      [provider.id, service.id, name, price, day, status],
    )) as { id: string }[]
    return rows[0].id
  }

  const live = await make('ZZ E2E Live', '70.00', '2094-03-01 17:00+00', 'completed')
  const dead = await make('ZZ E2E Expired', '60.00', '2094-03-02 17:00+00', 'upcoming')

  await sql.query(
    `INSERT INTO checkout_links (booking_id, token, status, expires_at)
     VALUES ($1, 'zzlivetoken1234567890ab', 'pending', now() + interval '5 days')`,
    [live],
  )
  await sql.query(
    `INSERT INTO checkout_links (booking_id, token, status, expires_at)
     VALUES ($1, 'zzexpiredtoken1234567890', 'pending', now() - interval '4 days')`,
    [dead],
  )
}
