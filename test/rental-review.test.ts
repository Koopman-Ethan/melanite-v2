import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getReviewQueue } from '@/lib/db/queries/review-queue'
import { REVIEW_STARTED_AT, rentOwedFor, reviewRentalFee } from '@/lib/rental/review'

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
  // Inside the reviewable window. These used to sit three weeks back, which stopped meaning
  // anything the moment REVIEW_STARTED_AT existed — a fixture before the policy began is
  // correctly invisible, and every assertion here would have been passing for the wrong reason.
  for (let back = 2; back < 120; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, original_price, price, payment_source,
            duration_mins, start_time, end_time, status, outcome_reason, notes, cancelled_at)
         VALUES ($1, $2, '0.00', '0.00', 'rental', 60,
                 now() - ($3::int || ' hours')::interval,
                 now() - (($3::int - 1) || ' hours')::interval,
                 $4, $5, $6,
                 -- An hour's notice, so these are LATE cancellations. Without a cancelled_at
                 -- they read as proper notice and are correctly nobody's decision, which would
                 -- have every assertion below passing for the wrong reason.
                 now() - (($3::int + 1) || ' hours')::interval)
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
      WHERE revenue_model = 'rental' AND billing_payment_method_id IS NULL LIMIT 1`,
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
    expect(await rentOwedFor(id)).toEqual({ kind: 'charged', cents: 3500 })
  })

  it('still holds the fee after a no-show', async () => {
    // And this used to be refunded by `markNoShow`, which is what v2 of the rental terms told
    // providers in as many words. v3 withdrew it, which is why that bump forces re-acceptance.
    const id = await heldBooking('no_show', 'Client did not turn up and has not replied.')
    expect(await rentOwedFor(id)).toEqual({ kind: 'charged', cents: 3500 })
  })

  it('holds nothing against a session nobody owes for', async () => {
    // Read-only, so picking a real row is safe here — unlike the review test below, which
    // decides money and therefore builds its own.
    // "Non-rental" STOPPED MEANING "nothing to decide" on 12 October, which is what this test
    // originally assumed. A cancelled booking belonging to one of the grandfathered three is
    // not a rental booking and is very much a decision — Melanite's half of it is owed or it is
    // not. What is genuinely nothing is a session worth nothing to anybody: Melanite's own, or
    // one comped to zero.
    const rows = (await sql.query(
      `SELECT b.id FROM bookings b
         JOIN providers p ON p.id = b.provider_id
        WHERE b.status = 'cancelled'
          AND (p.revenue_model = 'house' OR (b.payment_source <> 'rental' AND b.price = 0))
        LIMIT 1`,
    )) as { id: string }[]
    if (rows.length === 0) return
    expect(await rentOwedFor(rows[0].id)).toBeNull()
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

    expect(await reviewRentalFee(id, 'waive', adminId)).toEqual({ waived: true })

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
    await reviewRentalFee(id, 'waive', adminId)

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
    expect(await reviewRentalFee(id, 'waive', adminId)).toEqual({ waived: true })

    const again = await reviewRentalFee(id, 'waive', adminId)
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

    const out = await reviewRentalFee(rows[0].id, 'waive', adminId)
    expect(out).toHaveProperty('error')
  })

  it('refuses a session nobody owes for', async () => {
    // ITS OWN FIXTURE, never a row it found. The first version of this test picked the first
    // cancelled booking in the database and called `reviewRentalFee(..., 'waive')` on it — and
    // when 50/50 sessions became reviewable it started finding real ones. It waived a booking
    // Ethan had just made, mid-test-pass, and the only sign was the item quietly leaving the
    // queue. A test that decides real money is worse than no test.
    //
    // `comped` is a session worth nothing to anybody, which is the state being described.
    let id = ''
    for (let back = 2; back < 120; back += 2) {
      try {
        const rows = (await sql.query(
          `INSERT INTO bookings
             (provider_id, provider_service_id, client_name, original_price, price,
              payment_source, duration_mins, start_time, end_time, status, notes)
           VALUES ($1, $2, 'ZZ nothing owed', '0.00', '0.00', 'comped', 60,
                   now() - ($3::int || ' hours')::interval,
                   now() - (($3::int - 1) || ' hours')::interval, 'cancelled', $4)
           RETURNING id`,
          [providerId, providerServiceId, String(back), TAG],
        )) as { id: string }[]
        id = rows[0].id
        bookingIds.push(id)
        break
      } catch (err) {
        const e = err as { cause?: { code?: string }; code?: string }
        if ((e.code ?? e.cause?.code) !== '23P01') throw err
      }
    }
    expect(id).not.toBe('')

    const out = await reviewRentalFee(id, 'waive', adminId)
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/nothing to decide/i)
  })

  it('refuses one that does not exist', async () => {
    const out = await reviewRentalFee('00000000-0000-0000-0000-000000000000', 'waive', adminId)
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

    expect(await rentOwedFor(id)).toBeNull()
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)).toBeUndefined()
  })
})

describe('cancelling something that has already finished', () => {
  it('is refused by the action, and not offered by the card', async () => {
    // Until 12 October `cancelBooking` checked the status and never the clock, while
    // markCompleted and markNoShow both refuse a session that has not started. The asymmetry
    // cost little when a cancellation merely freed a slot; it matters now that the hour was
    // taken off everybody else and may already have been charged, and that "Cancelled" on
    // Keoni's queue reads as a session that never happened. Ethan cancelled one from the
    // previous afternoon during testing and it went straight through.
    //
    // Asserted against the source, the way `test/blocked-time.test.ts` asserts its five insert
    // sites: both of these live behind `requireProvider()`, so there is no seam to drive them
    // through without a session, and a rule enforced in one of the two places is the bug.
    const { readFileSync } = await import('node:fs')

    const action = readFileSync('app/app/appointments/actions.ts', 'utf8')
    expect(action, 'cancelBooking must refuse a session that is over').toMatch(
      /booking\.endTime <= new Date\(\)/,
    )
    expect(action).toMatch(/already finished/i)

    const card = readFileSync('app/app/appointments/appointment-actions.tsx', 'utf8')
    expect(card, 'the card must not offer a control the action will refuse').toMatch(
      /isFinished = appointment\.endTime <= new Date\(\)/,
    )
    expect(card).toMatch(/\{!isFinished && \(/)
  })
})

describe('what a 50/50 provider owes for a session that did not happen', () => {
  it('is half of what the client was being charged, not half the list price', async () => {
    // Found on screen: a session discounted from $125 to $115 reported $62.50 owed, because the
    // split was taken against `provider_services.price` rather than the booking's own. Melanite
    // would have claimed more than half of a sale worth $115 — and claimed it on the one screen
    // a provider reads to decide whether the arrangement is being honoured.
    const [prov] = (await sql.query(
      `SELECT id FROM providers WHERE revenue_model = 'split' LIMIT 1`,
    )) as { id: string }[]
    if (!prov) return

    const [ps] = (await sql.query(
      `SELECT id FROM provider_services WHERE provider_id = $1 AND is_active AND price > 0
       LIMIT 1`,
      [prov.id],
    )) as { id: string }[]
    if (!ps) return

    // Booked at 115 against a service listed higher, which is what a discount produces.
    let bookingId = ''
    // Inside the reviewable window, like every other fixture here.
    for (let back = 2; back < 120; back += 2) {
      try {
        const rows = (await sql.query(
          `INSERT INTO bookings
             (provider_id, provider_service_id, client_name, original_price, discount_type,
              discount_value, price, payment_source, duration_mins, start_time, end_time,
              status, notes, cancelled_at)
           VALUES ($1, $2, 'ZZ split review', '125.00', 'amount', '10.00', '115.00',
                   'checkout_link', 60,
                   now() - ($3::int || ' hours')::interval,
                   now() - (($3::int - 1) || ' hours')::interval, 'cancelled', $4,
                   -- An hour's notice, so it is a LATE cancellation and therefore a decision.
                   now() - (($3::int + 1) || ' hours')::interval)
           RETURNING id`,
          [prov.id, ps.id, String(back), TAG],
        )) as { id: string }[]
        bookingId = rows[0].id
        bookingIds.push(bookingId)
        break
      } catch (err) {
        const e = err as { cause?: { code?: string }; code?: string }
        if ((e.code ?? e.cause?.code) !== '23P01') throw err
      }
    }
    expect(bookingId).not.toBe('')

    const owed = await rentOwedFor(bookingId)
    expect(owed, 'a 50/50 session that did not happen is still a decision').not.toBeNull()
    if (owed && owed.kind === 'due') {
      // Half of 115, not half of 125.
      expect(owed.cents).toBe(5750)
      expect(owed.split, 'so the provider is not told she owes a "rental fee"').toBe(true)
    }
  })
})

describe('sessions from before the policy existed', () => {
  it('are not hers to decide', async () => {
    // Production holds seventeen cancellations for the three grandfathered providers going back
    // to 10 August — $812.88 of Melanite's half. Without a start date the queue opens on all of
    // them the morning this ships: decisions nobody was asked about at the time and that were
    // settled months ago. A queue like that is one she stops opening.
    const [prov] = (await sql.query(
      `SELECT id FROM providers WHERE revenue_model = 'split' LIMIT 1`,
    )) as { id: string }[]
    if (!prov) return
    const [ps] = (await sql.query(
      `SELECT id FROM provider_services WHERE provider_id = $1 AND is_active AND price > 0 LIMIT 1`,
      [prov.id],
    )) as { id: string }[]
    if (!ps) return

    const before = new Date(REVIEW_STARTED_AT.getTime() - 7 * 86_400_000)
    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price, payment_source,
          duration_mins, start_time, end_time, status, notes)
       VALUES ($1, $2, 'ZZ before policy', '100.00', '100.00', 'checkout_link', 60,
               $3::timestamptz, $3::timestamptz + interval '1 hour', 'cancelled', $4)
       RETURNING id`,
      [prov.id, ps.id, before.toISOString(), TAG],
    )) as { id: string }[]
    bookingIds.push(rows[0].id)

    expect(await rentOwedFor(rows[0].id)).toBeNull()

    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === rows[0].id)).toBeUndefined()
  })
})

describe('how much notice was given', () => {
  it('asks nothing of a cancellation made well ahead', async () => {
    // Keoni's rule of 12 October: the reason box and the queue item are for cancellations inside
    // `late_cancellation_hours`. A week's notice hands the slot back in time for somebody else,
    // so Melanite has lost nothing and there is nothing to decide — and a queue full of
    // non-events is one where the real ones stop being visible.
    const id = await heldBooking('cancelled', 'Client rebooked for next month.')

    // Cancelled a fortnight before it was due, rather than an hour.
    await sql.query(
      `UPDATE bookings SET cancelled_at = start_time - interval '14 days' WHERE id = $1`,
      [id],
    )

    expect(await rentOwedFor(id)).toBeNull()
    const queue = await getReviewQueue()
    expect(queue.find((q) => q.id === id)).toBeUndefined()
  })

  it('still asks when the notice is short', async () => {
    const id = await heldBooking('cancelled', 'Client cancelled an hour before.')
    await sql.query(
      `UPDATE bookings SET cancelled_at = start_time - interval '1 hour' WHERE id = $1`,
      [id],
    )
    expect(await rentOwedFor(id)).not.toBeNull()
  })

  it('always asks about a no-show, whatever the clock says', async () => {
    // It cannot be marked before the appointment has started, so there was never any notice.
    const id = await heldBooking('no_show', 'Nobody came.')
    await sql.query(`UPDATE bookings SET cancelled_at = NULL WHERE id = $1`, [id])
    expect(await rentOwedFor(id)).not.toBeNull()
  })
})
