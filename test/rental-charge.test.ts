import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { chargeRentalFee, refundRentalFee, rentalFeeForBooking } from '@/lib/rental/charge'

// Charging a provider to use the laser.
//
// Every refusal in `chargeRentalFee` happens BEFORE the Stripe call, which is what makes these
// tests real: they drive the actual function against actual rows and assert it declines, with no
// network and no mocking. That is the same seam `test/fees.test.ts` uses, and it is the half of
// the money path worth testing hardest — a provider charged twice for one session, or charged for
// a service nobody has priced, is money taken wrongly.
//
// The successful charge is deliberately NOT tested here. It needs a real card and a real Stripe
// call, so it belongs in a manual pass on appdev; pretending otherwise with a mock would assert
// that the mock works.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ RENTAL ${Date.now()}`
const priced = { providerId: '', providerServiceId: '', bookingId: '' }
const unpriced = { providerServiceId: '', bookingId: '' }
let houseBookingId = ''
const bookingIds: string[] = []

/** A provider_service for a named catalogue service, so the fee lookup has something to find.
 *
 *  Deliberately does NOT require the service to be active. The unpriced fixture below is a
 *  RETIRED service, which is the only way that case still exists now that every bookable
 *  service has a fee — and it is the realistic shape of it too: a service is retired, and the
 *  appointments already made against it still have to be chargeable or refusable. */
async function providerServiceFor(providerId: string, serviceName: string): Promise<string> {
  const [svc] = (await sql.query(`SELECT id FROM services WHERE name = $1`, [
    serviceName,
  ])) as { id: string }[]
  if (!svc) throw new Error(`${serviceName} is not in the catalogue`)

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [providerId, svc.id],
  )) as { id: string }[]
  if (existing.length > 0) return existing[0].id

  const rows = (await sql.query(
    `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
     VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
    [providerId, svc.id],
  )) as { id: string }[]
  return rows[0].id
}

/** The laser is one shared resource behind an exclusion constraint, and dev carries real
 *  appointments. Walk back until a slot is free rather than failing on whoever was booked. */
async function book(providerId: string, providerServiceId: string): Promise<string> {
  for (let back = 200; back < 400; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, client_name, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, $3, '0.00', '0.00', 'comped', 60,
                 now() - ($4 || ' hours')::interval, now() - ($5 || ' hours')::interval, 'completed')
         RETURNING id`,
        [providerId, providerServiceId, TAG, String(back), String(back - 1)],
      )) as { id: string }[]
      bookingIds.push(rows[0].id)
      return rows[0].id
    } catch (err) {
      // Only an overlap is worth retrying — `lib/db/errors.ts` explains why a string match on the
      // constraint name would never fire here.
      const code = (err as { cause?: { code?: string }; code?: string })
      const sqlState = code.code ?? code.cause?.code
      if (sqlState !== '23P01') throw err
    }
  }
  throw new Error('could not place a fixture booking')
}

beforeAll(async () => {
  // A provider with NO CARD, deliberately. Every refusal in this file happens before the
  // Stripe call, and that is only true of a provider who cannot be charged — pick one who can
  // and `chargeRentalFee` succeeds, takes a real test-mode payment and writes a ledger row,
  // which is what happened the moment `dev-rental-ready.ts` started giving dev providers cards.
  //
  // Selected by the absence of a payment method rather than by booking gates, so the fixture
  // states its own requirement instead of depending on what the nightly copy happened to bring.
  const [prov] = (await sql.query(
    `SELECT id FROM providers
      WHERE revenue_model = 'split' AND billing_payment_method_id IS NULL
      LIMIT 1`,
  )) as { id: string }[]
  if (!prov) throw new Error('no card-less provider in dev — these tests need one')
  priced.providerId = prov.id

  // "Laser Hair Removal — Chin" is XS, $35 since the October schedule. The generic "IPL" was
  // retired when the catalogue split into areas and never had a fee of its own, which makes it
  // the one service left that the schedule refuses to price.
  priced.providerServiceId = await providerServiceFor(prov.id, 'Laser Hair Removal — Chin')
  unpriced.providerServiceId = await providerServiceFor(prov.id, 'IPL')

  priced.bookingId = await book(prov.id, priced.providerServiceId)
  unpriced.bookingId = await book(prov.id, unpriced.providerServiceId)

  const [house] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'house' LIMIT 1`,
  )) as { id: string }[]
  if (house) {
    const ps = await providerServiceFor(house.id, 'Laser Hair Removal — Chin')
    houseBookingId = await book(house.id, ps)
  }
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [bookingIds])
  await sql.query(`DELETE FROM bookings WHERE client_name = $1`, [TAG])
})

describe('what a session costs', () => {
  it('reads the fee off the service', async () => {
    expect(await rentalFeeForBooking(priced.bookingId)).toBe(3500)
  })

  it('is null for a service with no published fee', async () => {
    expect(await rentalFeeForBooking(unpriced.bookingId)).toBeNull()
  })

  it('is null for a booking that does not exist', async () => {
    expect(await rentalFeeForBooking('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('refusals, all of them before Stripe is called', () => {
  it('refuses a booking that does not exist', async () => {
    const out = await chargeRentalFee('00000000-0000-0000-0000-000000000000')
    expect(out).toHaveProperty('error')
  })

  it('refuses a service nobody has priced, rather than charging nothing', async () => {
    // The distinction the whole fee schedule turns on. A free session is worse than a blocked one
    // because nobody finds it until the month's takings are short.
    const out = await chargeRentalFee(unpriced.bookingId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/no published rental fee/i)
  })

  it('refuses when the provider has no card on file', async () => {
    // The guard that stops a booking being made against a provider nobody can bill. Real path:
    // the fixture provider genuinely has no payment method, nothing is mocked.
    const out = await chargeRentalFee(priced.bookingId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/no card on file/i)
  })

  it("skips Melanite's own appointment", async () => {
    if (!houseBookingId) return
    const out = await chargeRentalFee(houseBookingId)
    expect(out).toHaveProperty('skipped')
    if ('skipped' in out) expect(out.skipped).toMatch(/own appointment/i)
  })

  it('skips a session whose fee has already been charged', async () => {
    // The guard that matters most: a retry, a double submit, or a cancel-and-rebook must not bill
    // the same session twice. Asserted by writing the ledger row the charge would have written.
    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('rental_fee','provider','purchase','booking',$1,$2,
               '35.00','0.00','0.00','35.00','stripe','pi_zz_rental','paid')`,
      [priced.bookingId, priced.providerId],
    )

    const out = await chargeRentalFee(priced.bookingId)
    expect(out).toHaveProperty('skipped')
    if ('skipped' in out) expect(out.skipped).toMatch(/already been charged/i)
  })
})

describe('giving the fee back', () => {
  it('skips a session that was never charged', async () => {
    const out = await refundRentalFee(unpriced.bookingId)
    expect(out).toHaveProperty('skipped')
    if ('skipped' in out) expect(out.skipped).toMatch(/no rental fee/i)
  })

  it('skips one already refunded', async () => {
    // Relies on the purchase row written above. The refund row is inserted directly, because the
    // Stripe call itself is not what this asserts.
    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('rental_fee','provider','refund','booking',$1,$2,
               '-35.00','0.00','0.00','-35.00','stripe','pi_zz_rental','paid')`,
      [priced.bookingId, priced.providerId],
    )

    const out = await refundRentalFee(priced.bookingId)
    expect(out).toHaveProperty('skipped')
    if ('skipped' in out) expect(out.skipped).toMatch(/already been refunded/i)
  })
})

describe('the ledger shape a rental fee has to satisfy', () => {
  it('accepts a provider-paid row with no payout, and a negative refund', async () => {
    // The check constraint is what stops a rental fee being recorded as though half of it were
    // owed to the provider. Both signs must satisfy it, which is why the refund is negative on
    // BOTH columns rather than only on gross.
    const rows = (await sql.query(
      `SELECT entry_type, gross_amount, provider_payout, melanite_cut
         FROM ledger_entries WHERE subject_id = $1 ORDER BY entry_type`,
      [priced.bookingId],
    )) as { entry_type: string; gross_amount: string; provider_payout: string; melanite_cut: string }[]

    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(Number(r.provider_payout)).toBe(0)
      expect(Number(r.melanite_cut)).toBe(Number(r.gross_amount))
    }
    expect(Number(rows.find((r) => r.entry_type === 'refund')!.gross_amount)).toBeLessThan(0)
  })
})
