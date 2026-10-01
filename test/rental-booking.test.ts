import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { unchargedRentalBookings } from '@/lib/rental/charge'
import { claimPackSession, grantPack, recordPackRedemption } from '@/lib/rental/packs'

// Booking the laser under the rental model.
//
// The booking action itself needs a signed-in provider and a live Stripe call, so what is tested
// here is everything underneath it that has to be true regardless of who is calling:
//
//   - the database refuses to hold a client on a rental booking, which is the promise Keoni is
//     making to providers rather than a convention of one form;
//   - the sweep finds a booking that was taken but never billed, which is the compensating
//     control for charging AFTER the slot is claimed.
//
// The ordering that makes that second one necessary is deliberate and documented in
// `app/app/book/actions.ts`: the slot is claimed first because `bookings_no_overlap` can only
// arbitrate a shared laser once a row exists, and the charge follows immediately. A crash in
// between leaves an unbilled appointment, which cannot be prevented without a transaction the
// driver does not have — so it is detected instead.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ RENTBOOK ${Date.now()}`
let providerId = ''
let houseProviderId = ''
let providerServiceId = ''
let houseServiceId = ''
const bookingIds: string[] = []
const packIds: string[] = []

async function providerServiceFor(pid: string, serviceName: string): Promise<string> {
  const [svc] = (await sql.query(`SELECT id FROM services WHERE name = $1 AND active`, [
    serviceName,
  ])) as { id: string }[]
  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [pid, svc.id],
  )) as { id: string }[]
  if (existing[0]) return existing[0].id
  const rows = (await sql.query(
    `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
     VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
    [pid, svc.id],
  )) as { id: string }[]
  return rows[0].id
}

/** A rental booking, placed by walking back until the shared laser is free. */
async function bookRental(pid: string, psid: string): Promise<string> {
  for (let back = 900; back < 1200; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, notes, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, $3, '0.00', '0.00', 'rental', 60,
                 now() - ($4 || ' hours')::interval, now() - ($5 || ' hours')::interval, 'upcoming')
         RETURNING id`,
        [pid, psid, TAG, String(back), String(back - 1)],
      )) as { id: string }[]
      bookingIds.push(rows[0].id)
      return rows[0].id
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }
  throw new Error('could not place a fixture booking')
}

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'split' AND booking_enabled LIMIT 1`,
  )) as { id: string }[]
  providerId = prov.id
  providerServiceId = await providerServiceFor(providerId, 'Laser Hair Removal — Chin')

  const [house] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'house' LIMIT 1`,
  )) as { id: string }[]
  if (house) {
    houseProviderId = house.id
    houseServiceId = await providerServiceFor(houseProviderId, 'Laser Hair Removal — Chin')
  }
})

afterAll(async () => {
  await sql.query(`DELETE FROM provider_pack_redemptions WHERE booking_id = ANY($1::uuid[])`, [
    bookingIds,
  ])
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [bookingIds])
  await sql.query(`DELETE FROM bookings WHERE notes = $1`, [TAG])
  await sql.query(`DELETE FROM provider_packs WHERE id = ANY($1::uuid[])`, [packIds])
})

describe('a rental booking holds no client', () => {
  it('refuses a name', async () => {
    // Keoni's reason for the whole change was her name appearing on a stranger's receipt. "We
    // do not store your clients" is a promise, so it is a constraint rather than a habit of
    // whichever form happens to be posting.
    await expect(
      sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, client_name, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, 'Jane Doe', '0.00', '0.00', 'rental', 60,
                 now() + interval '400 days', now() + interval '400 days' + interval '1 hour',
                 'upcoming')`,
        [providerId, providerServiceId],
      ),
    ).rejects.toThrow()
  })

  it('refuses an email', async () => {
    await expect(
      sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, client_email, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, 'jane@example.com', '0.00', '0.00', 'rental', 60,
                 now() + interval '401 days', now() + interval '401 days' + interval '1 hour',
                 'upcoming')`,
        [providerId, providerServiceId],
      ),
    ).rejects.toThrow()
  })

  it('refuses a client price', async () => {
    // A figure here would be read as revenue by every report that sums the column, and Melanite
    // genuinely does not know what the provider charged.
    await expect(
      sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, '150.00', '150.00', 'rental', 60,
                 now() + interval '402 days', now() + interval '402 days' + interval '1 hour',
                 'upcoming')`,
        [providerId, providerServiceId],
      ),
    ).rejects.toThrow()
  })

  it('leaves older bookings alone', async () => {
    // The constraints are conditional on payment_source. Every appointment made before the
    // cutover has a client name and a price, and they must stay readable.
    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM bookings
        WHERE payment_source <> 'rental' AND client_name IS NOT NULL`,
    )) as { n: number }[]
    expect(row.n).toBeGreaterThan(0)
  })
})

describe('finding a booking nobody was billed for', () => {
  it('reports one with no rental fee against it', async () => {
    // Exactly the state a crash between the insert and the charge would leave behind.
    const bookingId = await bookRental(providerId, providerServiceId)

    const found = await unchargedRentalBookings()
    expect(found.map((b) => b.bookingId)).toContain(bookingId)
  })

  it('does not report one that was charged', async () => {
    const bookingId = await bookRental(providerId, providerServiceId)
    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('rental_fee','provider','purchase','booking',$1,$2,
               '40.00','0.00','0.00','40.00','stripe','pi_zz_rentbook','paid')`,
      [bookingId, providerId],
    )

    const found = await unchargedRentalBookings()
    expect(found.map((b) => b.bookingId)).not.toContain(bookingId)
  })

  it('does not report one a pack paid for', async () => {
    // A pack session is paid for up front and writes no ledger row against the booking, so
    // without this it would look unbilled forever.
    const granted = await grantPack({
      providerId,
      tierKey: 'lhr_xs',
      sessions: 1,
      note: TAG,
    })
    if ('error' in granted) throw new Error(granted.error)
    packIds.push(granted.packId)

    const bookingId = await bookRental(providerId, providerServiceId)
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    await recordPackRedemption(claim!, bookingId)

    const found = await unchargedRentalBookings()
    expect(found.map((b) => b.bookingId)).not.toContain(bookingId)
  })

  it('does not report Melanite’s own appointment', async () => {
    if (!houseProviderId) return
    const bookingId = await bookRental(houseProviderId, houseServiceId)

    const found = await unchargedRentalBookings()
    expect(found.map((b) => b.bookingId)).not.toContain(bookingId)
  })
})
