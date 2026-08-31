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
  // Equipment photos too, and they are not optional: the FK is ON DELETE RESTRICT, so a check
  // left behind does not orphan — it blocks the booking delete outright and every later run
  // accumulates another year-2099 ghost on the admin calendar.
  await query.query(
    `DELETE FROM equipment_checks WHERE booking_id IN (
       SELECT id FROM bookings WHERE client_name LIKE 'ZZ E2E %'
     )`,
  )
  await query.query(`DELETE FROM bookings WHERE client_name LIKE 'ZZ E2E %'`)

  // The objects those rows pointed at. Only ever the dev prefix — production photographs are
  // never reachable from here, and `deleteEquipmentPhoto` refuses outside production for the
  // same reason. Best effort: a blob store that is not configured, or a delete that fails, must
  // not fail a teardown whose real job is the database.
  if (process.env.BLOB_READ_WRITE_TOKEN && process.env.MELANITE_ENV !== 'prod') {
    try {
      const { del, list } = await import('@vercel/blob')
      const { blobs } = await list({ prefix: 'equipment/dev/' })
      await Promise.all(blobs.map((b) => del(b.url)))
    } catch (err) {
      console.warn('[cleanup] could not sweep dev equipment photos', err)
    }
  }
  await query.query(`DELETE FROM clients WHERE email = 'zz.e2e@example.com'`)

  // The package spec sends a real payment link each run. Without this they pile up on the
  // provider's "awaiting payment" list, which is meant to be a short list of real sales.
  await query.query(`DELETE FROM package_checkout_links WHERE client_name LIKE 'ZZ E2E %'`)

  // And the template it sells. Left behind, it shows up on a real provider's packages list on
  // appdev, which Keoni looks at — the spec rebuilds it from scratch next run.
  const tmpl = `SELECT id FROM package_templates WHERE name = 'ZZ E2E Package'`
  await query.query(`DELETE FROM package_template_items WHERE package_template_id IN (${tmpl})`)
  await query.query(
    `DELETE FROM package_templates WHERE name = 'ZZ E2E Package'
       AND NOT EXISTS (SELECT 1 FROM client_packages WHERE package_template_id = package_templates.id)`,
  )

  // The onboarding journey builds a whole provider out of an invite. Sessions and services
  // both reference it, so those go first.
  const created = `SELECT id FROM providers WHERE email LIKE 'zz.onboard.%@example.com'`
  await query.query(`DELETE FROM sessions WHERE provider_id IN (${created})`)
  await query.query(`DELETE FROM provider_services WHERE provider_id IN (${created})`)
  await query.query(`DELETE FROM providers WHERE email LIKE 'zz.onboard.%@example.com'`)
  await query.query(`DELETE FROM invite_links WHERE email LIKE 'zz.onboard.%@example.com'`)
})
