import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { noteBookingCherryHandoff, noteCherryHandoff } from '@/app/pay/actions'
import { getCherryHandoffs } from '@/lib/db/queries/admin-tools'
import { cherryAvailable, CHERRY_MINIMUM } from '@/lib/payments/cherry'

// Cherry is the one payment route with no webhook and no callback.
//
// The client leaves for Cherry's site, Cherry pays Melanite, and Melanite owes the provider
// their half. None of that reaches this app on its own. The single timestamp written as they
// leave is the whole signal, so if it lands in the wrong row the client is gone and nobody
// knows to look for them.
//
// That is not hypothetical: `cherry_started_at` was originally added to `checkout_links` while
// building PACKAGE financing. The two tables have near-identical column lists, so the write
// compiled, matched zero rows, and recorded nothing. `db:verify` cannot see that class of
// mistake — both tables have the column now and both are legitimate — so it is caught here, by
// running each action and reading back the row it was supposed to touch.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let bookingId = ''
let bookingLinkToken = ''
let packageLinkToken = ''
let templateId = ''

beforeAll(async () => {
  const [ps] = (await sql.query(
    `SELECT ps.id, ps.provider_id FROM provider_services ps WHERE ps.is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerId = ps.provider_id

  // Far future so this cannot collide with anything real on the laser.
  const [booking] = (await sql.query(
    `INSERT INTO bookings (provider_id, provider_service_id, client_name, client_email,
                           original_price, price, payment_source, duration_mins,
                           start_time, end_time, status)
     VALUES ($1, $2, 'ZZ Cherry Client', 'zz.cherry@example.com', '450.00', '450.00',
             'checkout_link', 60, '2096-03-04T18:00:00Z', '2096-03-04T19:00:00Z', 'upcoming')
     RETURNING id`,
    [providerId, ps.id],
  )) as { id: string }[]
  bookingId = booking.id

  bookingLinkToken = `zz-cherry-booking-${bookingId.slice(0, 8)}`
  await sql.query(
    `INSERT INTO checkout_links (booking_id, token, status, expires_at)
     VALUES ($1, $2, 'pending', now() + interval '7 days')`,
    [bookingId, bookingLinkToken],
  )

  const [tpl] = (await sql.query(
    `INSERT INTO package_templates (provider_id, name, total_price)
     VALUES ($1, 'ZZ Cherry Package', '1200.00') RETURNING id`,
    [providerId],
  )) as { id: string }[]
  templateId = tpl.id

  packageLinkToken = `zz-cherry-package-${templateId.slice(0, 8)}`
  await sql.query(
    `INSERT INTO package_checkout_links (package_template_id, provider_id, token, price,
                                         client_name, status, expires_at)
     VALUES ($1, $2, $3, '1200.00', 'ZZ Cherry Client', 'pending', now() + interval '7 days')`,
    [templateId, providerId, packageLinkToken],
  )
})

afterAll(async () => {
  await sql.query(`DELETE FROM checkout_links WHERE token = $1`, [bookingLinkToken])
  await sql.query(`DELETE FROM package_checkout_links WHERE token = $1`, [packageLinkToken])
  if (bookingId) await sql.query(`DELETE FROM bookings WHERE id = $1`, [bookingId])
  if (templateId) await sql.query(`DELETE FROM package_templates WHERE id = $1`, [templateId])
})

describe('the floor', () => {
  it('hides Cherry below the amount they will write a plan for', () => {
    // Offering it on a $150 service sends the client to a page that turns them down, which
    // reads as a promise the practice could not keep.
    expect(cherryAvailable('https://cherry.example/apply', '150.00')).toBe(false)
    expect(cherryAvailable('https://cherry.example/apply', '200.00')).toBe(true)
    expect(cherryAvailable('https://cherry.example/apply', '450.00')).toBe(true)
    expect(CHERRY_MINIMUM).toBe(200)
  })

  it('compares as a number, not as a string', () => {
    // `money()` columns hand back strings. '90.00' >= '200' is TRUE as a string comparison,
    // which would offer financing on a $90 service and hide it on a $1,200 one.
    expect(cherryAvailable('https://cherry.example/apply', '90.00')).toBe(false)
    expect(cherryAvailable('https://cherry.example/apply', '1200.00')).toBe(true)
  })

  it('hides it entirely when Cherry is not configured', () => {
    // The URL is a platform setting that starts null. A financing button that goes nowhere is
    // worse than no financing button.
    expect(cherryAvailable(null, '1200.00')).toBe(false)
    expect(cherryAvailable('', '1200.00')).toBe(false)
  })
})

describe('the hand-off lands on the right row', () => {
  it('an appointment hand-off writes to checkout_links', async () => {
    await noteBookingCherryHandoff(bookingLinkToken)

    const [link] = (await sql.query(
      `SELECT cherry_started_at FROM checkout_links WHERE token = $1`,
      [bookingLinkToken],
    )) as Record<string, unknown>[]

    expect(link.cherry_started_at, 'the appointment hand-off recorded nothing').not.toBeNull()
  })

  it('and does not touch the package link', async () => {
    // The failure this whole file exists for. A token from one space matching a row in the
    // other would be silent in both directions.
    const [pkg] = (await sql.query(
      `SELECT cherry_started_at FROM package_checkout_links WHERE token = $1`,
      [packageLinkToken],
    )) as Record<string, unknown>[]

    expect(pkg.cherry_started_at).toBeNull()
  })

  it('a package hand-off writes to package_checkout_links', async () => {
    await noteCherryHandoff(packageLinkToken)

    const [pkg] = (await sql.query(
      `SELECT cherry_started_at FROM package_checkout_links WHERE token = $1`,
      [packageLinkToken],
    )) as Record<string, unknown>[]

    expect(pkg.cherry_started_at).not.toBeNull()
  })

  it('keeps the FIRST hand-off when somebody clicks through twice', async () => {
    const [before] = (await sql.query(
      `SELECT cherry_started_at::text AS at FROM checkout_links WHERE token = $1`,
      [bookingLinkToken],
    )) as { at: string }[]

    await noteBookingCherryHandoff(bookingLinkToken)

    const [after] = (await sql.query(
      `SELECT cherry_started_at::text AS at FROM checkout_links WHERE token = $1`,
      [bookingLinkToken],
    )) as { at: string }[]

    // Somebody who goes to Cherry, comes back and clicks again has been waiting since the
    // first click. Resetting the clock would hide the oldest case from the chase list.
    expect(after.at).toBe(before.at)
  })

  it('a token that matches nothing does not throw', async () => {
    // This runs while a client is mid-way to a four-figure purchase. Whatever else happens, it
    // must not stand between them and Cherry.
    await expect(noteBookingCherryHandoff('zz-no-such-token')).resolves.toBeUndefined()
  })
})

describe('what Keoni has to chase', () => {
  it('lists appointments alongside packages, oldest first', async () => {
    const handoffs = await getCherryHandoffs(50)

    const booking = handoffs.find((h) => h.kind === 'booking' && h.what.includes(','))
    const pkg = handoffs.find((h) => h.what === 'ZZ Cherry Package')

    // Two lists would mean two places to remember to look, and the newer one is the one that
    // gets forgotten — the exact failure this screen exists to prevent.
    expect(booking, 'an appointment financed through Cherry appears nowhere for Keoni').toBeTruthy()
    expect(pkg, 'the package hand-off fell off the list').toBeTruthy()
    expect(pkg!.kind).toBe('package')

    const times = handoffs.map((h) => new Date(h.startedAt).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('drops an appointment once it is cancelled', async () => {
    await sql.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId])

    const handoffs = await getCherryHandoffs(50)
    expect(
      handoffs.some((h) => h.kind === 'booking' && h.price === '450.00'),
      'a cancelled appointment is not something to chase somebody about',
    ).toBe(false)

    await sql.query(`UPDATE bookings SET status = 'upcoming' WHERE id = $1`, [bookingId])
  })
})
