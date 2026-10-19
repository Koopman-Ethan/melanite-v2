import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getCherryHandoffs } from '@/lib/db/queries/admin-tools'

// Two signals Keoni had no way to see.
//
// A Groupon booking and a Groupon booking she has already collected on looked identical on the
// calendar — both just "paid outside the app". And a client who left for Cherry left no trace
// at all: the link sat at `pending` forever, indistinguishable from one nobody opened, while
// the page told them to "tell your provider".
//
// Neither of these is payment. They are the difference between knowing what is outstanding and
// having to ask somebody.
//
// ON APPOINTMENTS, not packages, since 14 October. These assertions were written against
// `package_checkout_links` and have been moved rather than deleted: the guard they cover still
// ships, on `checkout_links`, in `noteBookingCherryHandoff`. The source comment there says
// `cherry_started_at` once ended up on the wrong table because the two tables have
// near-identical column lists and the wrong one matches nothing silently — so a test holding
// the surviving half honest is worth more now that the other half is gone, not less.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
const bookingIds: string[] = []
const linkIds: string[] = []

const at = (hour: number) => new Date(Date.UTC(2094, 4, 2, hour)).toISOString()

async function externalBooking(hour: number, method = 'groupon') {
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        external_method, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, 'ZZ Recon', '200.00', '200.00', 'external', $3::payment_method, 60,
             $4::timestamptz, $5::timestamptz, 'upcoming')
     RETURNING id`,
    [providerId, providerServiceId, method, at(hour), at(hour + 1)],
  )) as { id: string }[]
  bookingIds.push(rows[0].id)
  return rows[0].id
}

/** The exact expression the calendar uses, so this tests what ships. */
async function reconciled(bookingId: string): Promise<boolean> {
  const [row] = (await sql.query(
    `SELECT exists (
       SELECT 1 FROM ledger_entries l
        WHERE l.subject_type = 'booking' AND l.subject_id = $1 AND l.entry_type = 'purchase'
     ) AS reconciled`,
    [bookingId],
  )) as { reconciled: boolean }[]
  return row.reconciled
}

beforeAll(async () => {
  const svc = (await sql.query(
    `SELECT id, provider_id, service_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string; service_id: string }[]
  providerServiceId = svc[0].id
  providerId = svc[0].provider_id
})

afterAll(async () => {
  // Links before bookings: `checkout_links.booking_id` cascades, but removing the link first
  // keeps the teardown correct whichever way a future schema points the reference.
  for (const id of linkIds) await sql.query(`DELETE FROM checkout_links WHERE id = $1`, [id])
  for (const id of bookingIds) {
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
})

describe('has this external booking been collected on?', () => {
  it('starts as not reconciled', async () => {
    const id = await externalBooking(1)
    expect(await reconciled(id)).toBe(false)
  })

  it('becomes reconciled once money is recorded against it', async () => {
    const id = await externalBooking(3)
    expect(await reconciled(id)).toBe(false)

    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
          tip_amount, provider_payout, melanite_cut, payment_method, external_reference,
          payout_status)
       VALUES ('booking', 'client', 'purchase', 'booking', $1, $2, '200.00', '0.00', '100.00',
               '100.00', 'groupon', 'ZZ-VOUCHER', 'paid')`,
      [id, providerId],
    )

    expect(await reconciled(id)).toBe(true)
  })

  it('a refund does not make an unpaid booking look collected', async () => {
    // Only a `purchase` counts. Keying on "any ledger row" would mark a booking as settled the
    // moment a refund was recorded against it, which is the opposite of true.
    const id = await externalBooking(5)
    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
          tip_amount, provider_payout, melanite_cut, payment_method, payout_status)
       VALUES ('booking', 'client', 'refund', 'booking', $1, $2, '-50.00', '0.00', '0.00',
               '-50.00', 'groupon', 'paid')`,
      [id, providerId],
    )
    expect(await reconciled(id)).toBe(false)
  })
})

describe('did the client go to Cherry?', () => {
  /** An appointment with a payment link on it, which is what a client finances through Cherry. */
  const makeLink = async (price: string) => {
    const bookingId = await externalBooking(10 + linkIds.length, 'cherry')
    const rows = (await sql.query(
      `INSERT INTO checkout_links (token, booking_id, status, expires_at)
       VALUES ($1, $2, 'pending', now() + interval '14 days')
       RETURNING id`,
      [`zzcherry${Date.now()}${linkIds.length}`, bookingId],
    )) as { id: string }[]
    linkIds.push(rows[0].id)
    await sql.query(`UPDATE bookings SET price = $2 WHERE id = $1`, [bookingId, price])
    return rows[0].id
  }

  /** The exact `where` clause of `noteBookingCherryHandoff`, so this tests what ships. */
  const noteHandoff = (id: string) =>
    sql.query(
      `UPDATE checkout_links SET cherry_started_at = now()
        WHERE id = $1 AND status = 'pending' AND cherry_started_at IS NULL`,
      [id],
    )

  it('records the hand-off without claiming payment', async () => {
    const id = await makeLink('600.00')
    await noteHandoff(id)

    const [row] = (await sql.query(
      `SELECT status, cherry_started_at FROM checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]

    expect(row.cherry_started_at).not.toBeNull()
    // Still pending, and that is the point. They went to Cherry; nobody has said they paid.
    // Marking it paid because a link was clicked would be worse than no signal at all.
    expect(row.status).toBe('pending')
  })

  it('keeps the first hand-off time, not the latest click', async () => {
    const id = await makeLink('600.00')
    await sql.query(
      `UPDATE checkout_links SET cherry_started_at = now() - interval '2 hours' WHERE id = $1`,
      [id],
    )
    // ::text so the comparison is on the instant, not on two equal Date objects.
    const [before] = (await sql.query(
      `SELECT cherry_started_at::text FROM checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    // The guard is `cherry_started_at IS NULL`, so a client returning to the page and clicking
    // again does not reset when they first went.
    await noteHandoff(id)

    const [after] = (await sql.query(
      `SELECT cherry_started_at::text FROM checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    expect(after.cherry_started_at).toBe(before.cherry_started_at)
  })

  it('does not record a hand-off on a link that is already paid', async () => {
    const id = await makeLink('600.00')
    await sql.query(`UPDATE checkout_links SET status = 'paid' WHERE id = $1`, [id])

    await noteHandoff(id)

    const [row] = (await sql.query(
      `SELECT cherry_started_at FROM checkout_links WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]
    expect(row.cherry_started_at).toBeNull()
  })

})

// The half that was missing at first: the hand-off was recorded and shown nowhere. A signal
// only in the database is a signal nobody acts on, and Cherry is the one route where acting on
// it is the whole job — Cherry pays Melanite, and Melanite owes the provider half.

describe('who can see it', () => {
  const startCherry = (id: string) =>
    sql.query(
      `UPDATE checkout_links SET cherry_started_at = now() - interval '3 days' WHERE id = $1`,
      [id],
    )

  const makeLink = async () => {
    const bookingId = await externalBooking(40 + linkIds.length, 'cherry')
    const rows = (await sql.query(
      `INSERT INTO checkout_links (token, booking_id, status, expires_at)
       VALUES ($1, $2, 'pending', now() + interval '14 days')
       RETURNING id`,
      [`zzsee${Date.now()}${linkIds.length}`, bookingId],
    )) as { id: string }[]
    linkIds.push(rows[0].id)
    await sql.query(`UPDATE bookings SET price = '600.00' WHERE id = $1`, [bookingId])
    return rows[0].id
  }

  it('reaches Keoni, with enough to act on', async () => {
    const id = await makeLink()
    await startCherry(id)

    const row = (await getCherryHandoffs()).find((c) => c.id === id)
    expect(row, 'a Cherry hand-off must reach the admin tools page').toBeDefined()
    expect(row!.price).toBe('600.00')
    // Only appointments go through Cherry now, and the tools page labels them as such.
    expect(row!.kind).toBe('booking')
    // She has to chase this with a person, so the provider's name is not decoration.
    expect(row!.providerName.trim().length).toBeGreaterThan(0)
    expect(row!.waitingDays).toBe(3)
  })

  it('leaves her list once the appointment is paid for', async () => {
    // By any route, including her recording it by hand. A queue that cannot empty is one people
    // learn to scroll past.
    const id = await makeLink()
    await startCherry(id)
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(true)

    await sql.query(`UPDATE checkout_links SET status = 'paid' WHERE id = $1`, [id])
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(false)
  })

  it('does not chase a cancelled appointment', async () => {
    // Nobody owes anything for a treatment that is not happening, whatever they started on
    // Cherry. This clause is unique to the booking side, so it was never covered while these
    // assertions lived on packages.
    const id = await makeLink()
    await startCherry(id)
    const [link] = (await sql.query(`SELECT booking_id FROM checkout_links WHERE id = $1`, [
      id,
    ])) as { booking_id: string }[]

    await sql.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [link.booking_id])
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(false)
  })

  it('leaves it alone when nobody took it to Cherry', async () => {
    const id = await makeLink()
    expect((await getCherryHandoffs()).some((c) => c.id === id)).toBe(false)
  })
})

describe('Keoni sees the ones that need chasing first', () => {
  it('leads with the longest wait', async () => {
    // Oldest first: the one waiting longest is the one most likely to have been forgotten.
    const make = async (suffix: string, startedHoursAgo: number) => {
      const bookingId = await externalBooking(60 + linkIds.length, 'cherry')
      const rows = (await sql.query(
        `INSERT INTO checkout_links (token, booking_id, status, expires_at, cherry_started_at)
         VALUES ($1, $2, 'pending', now() + interval '14 days',
                 now() - ($3::int || ' hours')::interval)
         RETURNING id`,
        [`zzsort${Date.now()}${suffix}`, bookingId, String(startedHoursAgo)],
      )) as { id: string }[]
      linkIds.push(rows[0].id)
      return rows[0].id
    }

    const recent = await make('a', 1)
    const older = await make('b', 48)

    const list = await getCherryHandoffs()
    const olderAt = list.findIndex((c) => c.id === older)
    const recentAt = list.findIndex((c) => c.id === recent)

    expect(olderAt).toBeGreaterThanOrEqual(0)
    expect(recentAt).toBeGreaterThanOrEqual(0)
    expect(olderAt, 'the longest wait must come first').toBeLessThan(recentAt)
  })
})
