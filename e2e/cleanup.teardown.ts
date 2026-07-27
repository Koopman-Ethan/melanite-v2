import { test as teardown } from '@playwright/test'

import '../envConfig'

// Removes what the journey specs created.
//
// The booking test cancels its appointment through the UI, which is the right way to exercise
// the cancel path — but a cancelled booking is still a row, and one accumulates per run. Left
// alone they would slowly fill the admin calendar with year-2099 ghosts.
//
// Runs as Playwright's teardown, so it happens whether or not the tests passed. Cleanup that
// depends on a green run is cleanup that never happens on the days it matters.
teardown('remove e2e rows', async () => {
  const { neon } = await import('@neondatabase/serverless')
  const url = process.env.DATABASE_URL
  if (!url) return

  // `neon()` returns a tagged-template function; calling it with a plain string throws. Use
  // `.query()` for statements built as strings.
  const query = neon(url)

  // Children first — checkout links reference bookings.
  await query.query(
    `DELETE FROM checkout_links WHERE booking_id IN (
       SELECT id FROM bookings WHERE client_name LIKE 'ZZ E2E %'
     )`,
  )
  await query.query(`DELETE FROM bookings WHERE client_name LIKE 'ZZ E2E %'`)
  await query.query(`DELETE FROM clients WHERE email = 'zz.e2e@example.com'`)
})
