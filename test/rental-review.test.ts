import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getReviewQueue } from '@/lib/db/queries/review-queue'
import { heldRentalFor, reviewRentalFee } from '@/lib/rental/review'

// Who decides whether a provider gets the rent back.
//
// Keoni does, and nothing else does. The behaviour this replaced refunded a no-show or a
// cancellation on the spot, which meant the software was answering "whose fault was it?" —
// always the client's, always a refund, without anybody reading a word. Her instruction on
// 7 October: "sometimes its the clients fault, and not the providers".
//
// So the three things worth testing hardest are all about MONEY NOT MOVING ON ITS OWN:
//
//   1. A cancelled or missed session still holds what the provider paid.
//   2. It is visible to Keoni — in the queue, with what the provider said.
//   3. A decision settles it exactly once, and the item leaves either way.
//
// The refund half calls Stripe, so it is covered here only as far as the refusals: the fixture
// provider has no card and no real PaymentIntent, and refunding an invented intent id would
// fail at Stripe rather than prove anything. `test/rental-charge.test.ts` draws the same line
// for the same reason.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ REVIEW ${Date.now()}`
let providerId = ''
let providerServiceId = ''
let adminId = ''
const bookingIds: string[] = []
const ledgerIds: string[] = []

/** A past rental booking in a terminal state, with a rental fee recorded against it.
 *
 *  The ledger row is written by hand rather than through `chargeRentalFee`, which would need a
 *  card and take real test-mode money. What is under test is the holding and the deciding, and
 *  both read the ledger rather than Stripe. */
async function heldBooking(status: 'cancelled' | 'no_show', reason: string | null, cents = 3500) {
  let bookingId = ''

  // The laser is one shared resource behind an exclusion constraint and dev carries real
  // appointments, so walk back until a slot is free.
  for (let back = 500; back < 900; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, original_price, price, payment_source,
            duration_mins, start_time, end_time, status, outcome_reason, notes)
         VALUES ($1, $2, '0.00', '0.00', 'rental', 60,
                 now() - ($3::int || ' hours')::interval,
                 now() - (($3::int - 1) || ' hours')::interval,
                 $4, $5, $6)
         RETURNING id`,
        [providerId, providerServiceId, String(back), status, reason, TAG],
      )) as { id: string }[]
      bookingId = rows[0].id
      bookingIds.push(bookingId)
      break
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }
  if (!bookingId) throw new Error('could not place a fixture booking')

  const led = (await sql.query(
    `INSERT INTO ledger_entries
       (source, payer, entry_type, subject_type, subject_id, provider_id,
        gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
        stripe_payment_intent_id, payout_status)
     VALUES ('rental_fee', 'provider', 'purchase', 'booking', $1, $2,
             $3, '0.00', '0.00', $3, 'stripe', $4, 'paid')
     RETURNING id`,
    [bookingId, providerId, (cents / 100).toFixed(2), `pi_zzrev_${bookingId.slice(0, 8)}`],
  )) as { id: string }[]
  ledgerIds.push(led[0].id)

  return bookingId
}

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers
      WHERE revenue_model = 'split' AND billing_payment_method_id IS NULL LIMIT 1`,
  )) as { id: string }[]
  if (!prov) throw new Error('no card-less provider in dev — these tests need one')
  providerId = prov.id

  const [svc] = (await sql.query(
    `SELECT id FROM services WHERE name = 'Laser Hair Removal — Chin'`,
  )) as { id: string }[]

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [providerId, svc.id],
  )) as { id: string }[]

  providerServiceId =
    existing[0]?.id ??
    (
      (await sql.query(
        `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
         VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
        [providerId, svc.id],
      )) as { id: string }[]
    )[0].id

  const [admin] = (await sql.query(
    `SELECT id FROM providers WHERE role IN ('platform_owner', 'developer') LIMIT 1`,
  )) as { id: string }[]
  adminId = admin.id
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE id = ANY($1::uuid[])`, [ledgerIds])
  await sql.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [bookingIds])
})

describe('what a session that did not happen is holding', () => {
  it('still holds the fee after a cancellation', async () => {
    // The whole change, in one assertion. This used to be refunded by `cancelBooking` before
    // the request finished.
    const id = await heldBooking('cancelled', 'Client cancelled on the morning.')
    expect(await heldRentalFor(id)).toEqual({ kind: 'card', cents: 3500 })
  })

  it('still holds the fee after a no-show', async () => {
    // And this used to be refunded by `markNoShow`, which is what v2 of the rental terms told
    // providers in as many words. v3 withdrew it, which is why that bump forces re-acceptance.
    const id = await heldBooking('no_show', 'Client did not turn up and has not replied.')
    expect(await heldRentalFor(id)).toEqual({ kind: 'card', cents: 3500 })
  })

  it('holds nothing against a booking that paid no rent', async () => {
    // Four other paths reach `cancelled` — package restore, prepaid return, admin tools, the
    // ETL — and none of them carries rent. Keoni must not be asked to adjudicate money that
    // was never taken, which is what would fill her queue with the pre-cutover bookings.
    const rows = (await sql.query(
      `SELECT id FROM bookings WHERE payment_source <> 'rental' AND status = 'cancelled' LIMIT 1`,
    )) as { id: string }[]
    if (rows.length === 0) return
    expect(await heldRentalFor(rows[0].id)).toBeNull()
  })
})

describe('what Keoni sees', () => {
  it('lists the held session with what the provider said', async () => {
    const id = await heldBooking('cancelled', 'Client had a reaction and I sent her home.')

    const queue = await getReviewQueue()
    const mine = queue.find((q) => q.kind === 'held_rent' && q.id === id)

    expect(mine, 'a held fee has to appear in the queue').toBeDefined()
    expect(mine?.amount).toBe('35.00')
    // Her words, not a status. The decision is unmakeable without them.
    expect(mine?.detail).toContain('sent her home')
    expect(mine?.detail).toContain('Cancelled')
  })

  it('says a no-show is a no-show', async () => {
    const id = await heldBooking('no_show', 'Nobody came and nobody called.')
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)?.detail).toContain('No-show')
  })

  it('does not hide that a provider was asked and said nothing', async () => {
    // Reachable only by a path that bypasses the UI gate — the admin tools, or a direct call.
    // Rendering it blank would look like the feature had not run; it has to read as a gap.
    const id = await heldBooking('cancelled', null)
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)?.detail).toContain('nothing recorded')
  })
})

describe('deciding', () => {
  it('lets the fee stand, and takes it off the list', async () => {
    const id = await heldBooking('cancelled', 'Changed my mind the day before.')

    expect(await reviewRentalFee(id, 'keep', adminId)).toEqual({ kept: true })

    // Nothing moved.
    const [led] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = $1 AND entry_type = 'refund'`,
      [id],
    )) as { n: number }[]
    expect(led.n).toBe(0)

    // But it is gone from the queue. "She looked at it and the fee stands" has to be
    // distinguishable from "nobody has looked", or the queue never empties and stops being read.
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)).toBeUndefined()
  })

  it('records who decided and when', async () => {
    const id = await heldBooking('no_show', 'Client no-showed, second time this month.')
    await reviewRentalFee(id, 'keep', adminId)

    const [row] = (await sql.query(
      `SELECT rental_reviewed_at, rental_reviewed_by FROM bookings WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]
    expect(row.rental_reviewed_at).not.toBeNull()
    expect(row.rental_reviewed_by).toBe(adminId)
  })

  it('refuses to decide the same fee twice', async () => {
    // The underlying refund is idempotent, but a second stamp would overwrite who decided and
    // when — and on the refund path would attempt a second refund of the same charge.
    const id = await heldBooking('cancelled', 'Double-click guard.')
    expect(await reviewRentalFee(id, 'keep', adminId)).toEqual({ kept: true })

    const again = await reviewRentalFee(id, 'keep', adminId)
    expect(again).toHaveProperty('error')
    if ('error' in again) expect(again.error).toMatch(/already been reviewed/i)
  })

  it('refuses an appointment that still stands', async () => {
    // There is nothing to decide about a session that has not fallen through, and deciding
    // would refund a fee for laser time somebody is about to use.
    const rows = (await sql.query(
      `SELECT id FROM bookings WHERE status = 'upcoming' LIMIT 1`,
    )) as { id: string }[]
    if (rows.length === 0) return

    const out = await reviewRentalFee(rows[0].id, 'keep', adminId)
    expect(out).toHaveProperty('error')
  })

  it('refuses a booking holding nothing', async () => {
    const rows = (await sql.query(
      `SELECT id FROM bookings WHERE payment_source <> 'rental' AND status = 'cancelled' LIMIT 1`,
    )) as { id: string }[]
    if (rows.length === 0) return

    const out = await reviewRentalFee(rows[0].id, 'keep', adminId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/nothing held/i)
  })

  it('refuses one that does not exist', async () => {
    const out = await reviewRentalFee('00000000-0000-0000-0000-000000000000', 'keep', adminId)
    expect(out).toHaveProperty('error')
  })
})

describe('a fee already given back', () => {
  it('leaves the queue without anything marking it resolved', async () => {
    // The reason the queue is derived rather than kept. A refund nets the ledger to zero, so
    // the item falls out on its own — there is no flag to forget to set, and no row that can
    // linger after the money has moved.
    const id = await heldBooking('cancelled', 'Refunded by hand in Stripe.')

    const led = (await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('rental_fee', 'provider', 'refund', 'booking', $1, $2,
               '-35.00', '0.00', '0.00', '-35.00', 'stripe', $3, 'paid')
       RETURNING id`,
      [id, providerId, `pi_zzrev_${id.slice(0, 8)}`],
    )) as { id: string }[]
    ledgerIds.push(led[0].id)

    expect(await heldRentalFor(id)).toBeNull()
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)).toBeUndefined()
  })
})
