import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getChargeTotals, getChargesByService, getRecentCharges } from '@/lib/db/queries/charges'
import { getLaserUse } from '@/lib/db/queries/revenue'
import { claimPackSession, grantPack, recordPackRedemption } from '@/lib/rental/packs'
import { releaseRentalForBooking } from '@/lib/rental/release'

// What a provider is shown about money, and what Keoni is shown about the machine.
//
// These two pages read the same ledger from opposite ends, and the mistake they could each make
// is the same one in mirror image: counting a row that belongs to the other side. The earnings
// page made it once already — a provider's own bills appeared on it, each showing a $0.00 share
// — and the fix was a `payer <> 'provider'` filter added after the fact. Here that filter is
// the premise, so these tests check the premise holds.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ CHARGES ${Date.now()}`
let providerId = ''
let providerServiceId = ''
let serviceId = ''
const bookingIds: string[] = []
const packIds: string[] = []
const ledgerIds: string[] = []

/** A rental booking inside the CURRENT Denver month.
 *
 *  The month matters: `getChargeTotals` and `getLaserUse` both report a "this month" figure, and
 *  a fixture placed a fixed number of hours in the past lands in last month for most of any
 *  given month — which made these pass in the last week of one and fail in the first week of the
 *  next. Anchored to the start of the month instead, walking forward until the shared laser is
 *  free. */
async function bookRental(): Promise<string> {
  for (let hour = 2; hour < 24 * 27; hour += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, notes, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         SELECT $1, $2, $3, '0.00', '0.00', 'rental', 60, s, s + interval '1 hour', 'upcoming'
           FROM (
             SELECT (date_trunc('month', now() AT TIME ZONE 'America/Denver')
                     + ($4 || ' hours')::interval) AT TIME ZONE 'America/Denver' AS s
           ) t
         RETURNING id`,
        [providerId, providerServiceId, TAG, String(hour)],
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

/** Unique per row. `ledger_entries_stripe_payment_intent_id_index` is unique on non-refund
 *  rows, which is correct — one Stripe payment is one purchase — so fixtures need real variety
 *  rather than one shared id. */
let intentSeq = 0

/** A rental fee row against a booking, as `chargeRentalFee` would write it. */
async function chargeRow(bookingId: string, amount: string, entryType = 'purchase') {
  const rows = (await sql.query(
    `INSERT INTO ledger_entries
       (source, payer, entry_type, subject_type, subject_id, provider_id, service_id,
        gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
        stripe_payment_intent_id, payout_status)
     VALUES ('rental_fee','provider',$1,'booking',$2,$3,$4,
             $5,'0.00','0.00',$5,'stripe',$6,'paid')
     RETURNING id`,
    [entryType, bookingId, providerId, serviceId, amount, `pi_zz_charges_${TAG}_${intentSeq++}`],
  )) as { id: string }[]
  ledgerIds.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'rental' AND booking_enabled LIMIT 1`,
  )) as { id: string }[]
  providerId = prov.id

  const [svc] = (await sql.query(
    `SELECT id FROM services WHERE name = 'Laser Hair Removal — Chin' AND active`,
  )) as { id: string }[]
  serviceId = svc.id

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [providerId, serviceId],
  )) as { id: string }[]
  providerServiceId = existing[0]
    ? existing[0].id
    : (
        (await sql.query(
          `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
           VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
          [providerId, serviceId],
        )) as { id: string }[]
      )[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM provider_pack_redemptions WHERE booking_id = ANY($1::uuid[])`, [
    bookingIds,
  ])
  await sql.query(`DELETE FROM ledger_entries WHERE id = ANY($1::uuid[])`, [ledgerIds])
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [bookingIds])
  await sql.query(`DELETE FROM bookings WHERE notes = $1`, [TAG])
  await sql.query(`DELETE FROM provider_packs WHERE id = ANY($1::uuid[])`, [packIds])
})

describe('what a provider is shown they paid', () => {
  it('counts a rental fee into the rental and the overall total alike', async () => {
    const before = await getChargeTotals(providerId)
    const bookingId = await bookRental()
    await chargeRow(bookingId, '40.00')
    const after = await getChargeTotals(providerId)

    expect(Number(after.rentalLifetime) - Number(before.rentalLifetime)).toBeCloseTo(40, 2)
    expect(Number(after.allLifetime) - Number(before.allLifetime)).toBeCloseTo(40, 2)
    expect(after.sessionsMonth).toBe(before.sessionsMonth + 1)
  })

  it('nets a refund off rather than counting it twice', async () => {
    // Refunds are negative on both columns, which is what lets every figure on the page be a
    // plain sum. A page that had to know which entry types to subtract would eventually get
    // one of them wrong.
    const before = await getChargeTotals(providerId)
    const bookingId = await bookRental()
    await chargeRow(bookingId, '60.00')
    await chargeRow(bookingId, '-60.00', 'refund')
    const after = await getChargeTotals(providerId)

    expect(Number(after.rentalLifetime)).toBeCloseTo(Number(before.rentalLifetime), 2)
  })

  it('attributes rent to the service it was for', async () => {
    const bookingId = await bookRental()
    await chargeRow(bookingId, '40.00')

    const rows = await getChargesByService(providerId)
    const chin = rows.find((r) => r.serviceName === 'Laser Hair Removal — Chin')
    expect(chin).toBeDefined()
    expect(Number(chin!.paid)).toBeGreaterThan(0)
  })

  it('lists the charge with the appointment it was for', async () => {
    const bookingId = await bookRental()
    await chargeRow(bookingId, '40.00')

    const recent = await getRecentCharges(providerId)
    const row = recent.find((r) => r.source === 'rental_fee' && r.startTime !== null)
    expect(row).toBeDefined()
    expect(row!.serviceName).toBe('Laser Hair Removal — Chin')
  })

  it('never shows a client payment', async () => {
    // The premise. Every row on this page is money the provider paid; a client's payment for a
    // pre-cutover booking carries the same provider_id and must not appear.
    const recent = await getRecentCharges(providerId, 100)
    const payers = (await sql.query(
      `SELECT DISTINCT payer FROM ledger_entries WHERE id = ANY($1::uuid[])`,
      [recent.map((r) => r.id)],
    )) as { payer: string }[]

    expect(payers.map((p) => p.payer)).toEqual(['provider'])
  })
})

describe('giving the rent back', () => {
  it('refunds a charged session', async () => {
    // Driven through the real function. The Stripe call is the only part not exercised, and
    // that refuses up front without a key, so the result says so rather than pretending.
    const bookingId = await bookRental()
    await chargeRow(bookingId, '40.00')

    const out = await releaseRentalForBooking(bookingId)
    // Either the refund went through, or Stripe is not configured in this environment — both
    // are honest outcomes and neither is "nothing was owed".
    expect('nothing' in out).toBe(false)
  })

  it('returns a pack session instead, when that is what paid', async () => {
    const granted = await grantPack({ providerId, tierKey: 'lhr_xs', sessions: 1, note: TAG })
    if ('error' in granted) throw new Error(granted.error)
    packIds.push(granted.packId)

    const bookingId = await bookRental()
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    await recordPackRedemption(claim!, bookingId)

    const out = await releaseRentalForBooking(bookingId)
    expect(out).toEqual({ returnedSession: true })

    const [row] = (await sql.query(`SELECT sessions_used FROM provider_packs WHERE id = $1`, [
      claim!.packId,
    ])) as { sessions_used: number }[]
    expect(Number(row.sessions_used)).toBe(claim!.sessionIndex - 1)
  })

  it('gives nothing back twice', async () => {
    const granted = await grantPack({ providerId, tierKey: 'lhr_small', sessions: 1, note: TAG })
    if ('error' in granted) throw new Error(granted.error)
    packIds.push(granted.packId)

    const bookingId = await bookRental()
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Underarms')
    await recordPackRedemption(claim!, bookingId)

    expect(await releaseRentalForBooking(bookingId)).toEqual({ returnedSession: true })
    // The second call must find nothing. A pack that grows when you poke it is the failure the
    // client-package version of this had.
    expect(await releaseRentalForBooking(bookingId)).toHaveProperty('nothing')
  })

  it('says nothing was owed for a booking that never paid rent', async () => {
    const bookingId = await bookRental()
    expect(await releaseRentalForBooking(bookingId)).toHaveProperty('nothing')
  })
})

describe('who is using the laser', () => {
  it('counts a session and its rent against the provider', async () => {
    const bookingId = await bookRental()
    await chargeRow(bookingId, '40.00')

    const rows = await getLaserUse()
    const mine = rows.find((r) => r.providerId === providerId)

    expect(mine).toBeDefined()
    expect(mine!.sessionsLifetime).toBeGreaterThan(0)
    expect(Number(mine!.rentLifetime)).toBeGreaterThan(0)
  })

  it('counts a pack session as use even though it brought in no rent', async () => {
    // The column that stops a provider working through a pack reading as somebody using the
    // machine for free.
    const granted = await grantPack({ providerId, tierKey: 'lhr_xs', sessions: 1, note: TAG })
    if ('error' in granted) throw new Error(granted.error)
    packIds.push(granted.packId)

    const bookingId = await bookRental()
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    await recordPackRedemption(claim!, bookingId)

    const rows = await getLaserUse()
    const mine = rows.find((r) => r.providerId === providerId)
    expect(mine!.packSessionsMonth).toBeGreaterThan(0)
  })
})
