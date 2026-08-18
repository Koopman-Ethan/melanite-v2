import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Prepaid dollar balances, against a real database.
//
// A balance is money paid before any appointment exists, spent later on whatever the client
// books. Two things make it riskier than a package session:
//
//  - It is an AMOUNT, not a count, so "spend the same session twice" becomes "spend the same
//    dollar twice", and a partial spend leaves a remainder that has to be collected on a card.
//  - Oldest-first allocation means ONE booking can legitimately draw on SEVERAL balances. The
//    first version of this schema had a unique index on booking_id alone — copied from
//    package_redemptions, where it is correct — which would have refused the second draw and
//    left the first balance debited for a booking that never happened.
//
// The claim statements here are the ones `bookFromPrepaid` issues, replicated rather than
// called so the test needs no session.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = 'ZZ_PREPAID_TEST'

let providerId = ''
let providerServiceId = ''
let clientId = ''
let oldBalanceId = ''
let newBalanceId = ''
let bookingId = ''

/** The claim exactly as `bookFromPrepaid` issues it: conditional on the money still being there. */
async function claim(balanceId: string, amount: string): Promise<boolean> {
  const rows = (await sql.query(
    `UPDATE prepaid_balances SET remaining_amount = remaining_amount - $2
      WHERE id = $1 AND remaining_amount >= $2
      RETURNING id`,
    [balanceId, amount],
  )) as unknown[]
  return rows.length > 0
}

async function remaining(balanceId: string): Promise<string> {
  const rows = (await sql.query(
    `SELECT remaining_amount FROM prepaid_balances WHERE id = $1`,
    [balanceId],
  )) as { remaining_amount: string }[]
  return rows[0].remaining_amount
}

/** Allocation as the action performs it: oldest first, taking what each balance can cover. */
async function allocate(cents: number): Promise<Array<{ id: string; cents: number }>> {
  const balances = (await sql.query(
    `SELECT id, remaining_amount FROM prepaid_balances
      WHERE client_id = $1 AND provider_id = $2 AND status = 'active' AND remaining_amount > 0
      ORDER BY purchased_at ASC`,
    [clientId, providerId],
  )) as { id: string; remaining_amount: string }[]

  const claims: Array<{ id: string; cents: number }> = []
  let outstanding = cents

  for (const b of balances) {
    if (outstanding <= 0) break
    const take = Math.min(Math.round(Number(b.remaining_amount) * 100), outstanding)
    if (take <= 0) continue
    if (!(await claim(b.id, (take / 100).toFixed(2)))) continue
    claims.push({ id: b.id, cents: take })
    outstanding -= take
  }

  return claims
}

/** Asserts the database refuses the write, and by the constraint we expect rather than by luck. */
async function rejects(run: () => Promise<unknown>, expectedConstraint: string) {
  let constraint: string | undefined
  let detail = ''

  try {
    await run()
  } catch (err) {
    const cause = (err as { cause?: Record<string, unknown> }).cause
    constraint =
      (cause?.constraint as string | undefined) ??
      ((err as Record<string, unknown>).constraint as string | undefined)
    detail =
      (cause?.message as string | undefined) ?? (err as Error).message ?? String(err)
  }

  expect(detail, 'the database accepted a write it should have refused').not.toBe('')
  expect(constraint, `rejected, but by ${constraint ?? 'something else'}: ${detail}`).toBe(
    expectedConstraint,
  )
}

beforeAll(async () => {
  const pick = (await sql.query(
    `SELECT ps.id, ps.provider_id, ps.duration_mins FROM provider_services ps
      WHERE ps.is_active LIMIT 1`,
  )) as { id: string; provider_id: string; duration_mins: number }[]

  providerServiceId = pick[0].id
  providerId = pick[0].provider_id

  const client = (await sql.query(
    `INSERT INTO clients (name, email) VALUES ('ZZ Prepaid', $1) RETURNING id`,
    [`${TAG}@example.com`],
  )) as { id: string }[]
  clientId = client[0].id

  // Deliberately out of insertion order: the older, smaller balance is created second, so a
  // test that passes only because rows come back in insert order fails here.
  const newer = (await sql.query(
    `INSERT INTO prepaid_balances
       (provider_id, client_id, original_amount, remaining_amount, purchased_at, status)
     VALUES ($1, $2, '200.00', '200.00', now(), 'active') RETURNING id`,
    [providerId, clientId],
  )) as { id: string }[]
  newBalanceId = newer[0].id

  const older = (await sql.query(
    `INSERT INTO prepaid_balances
       (provider_id, client_id, original_amount, remaining_amount, purchased_at, status)
     VALUES ($1, $2, '50.00', '50.00', now() - interval '30 days', 'active') RETURNING id`,
    [providerId, clientId],
  )) as { id: string }[]
  oldBalanceId = older[0].id

  const start = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + pick[0].duration_mins * 60_000)

  const booking = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_id, client_name, original_price, price,
        payment_source, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, $3, 'ZZ Prepaid', '250.00', '0.00', 'prepaid', $4, $5, $6, 'cancelled')
     RETURNING id`,
    [providerId, providerServiceId, clientId, pick[0].duration_mins, start.toISOString(), end.toISOString()],
  )) as { id: string }[]
  bookingId = booking[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM prepaid_redemptions WHERE booking_id = $1`, [bookingId])
  await sql.query(`DELETE FROM bookings WHERE id = $1`, [bookingId])
  await sql.query(`DELETE FROM prepaid_balances WHERE client_id = $1`, [clientId])
  await sql.query(`DELETE FROM clients WHERE id = $1`, [clientId])
})

describe('claiming money off a balance', () => {
  it('lets exactly one of two concurrent claims take the last of it', async () => {
    // $50 left, both want $40. Sequentially the second must fail; concurrently, exactly one.
    const [a, b] = await Promise.all([
      claim(oldBalanceId, '40.00'),
      claim(oldBalanceId, '40.00'),
    ])

    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await remaining(oldBalanceId)).toBe('10.00')

    await sql.query(`UPDATE prepaid_balances SET remaining_amount = '50.00' WHERE id = $1`, [
      oldBalanceId,
    ])
  })

  it('refuses a claim larger than what is left', async () => {
    expect(await claim(oldBalanceId, '50.01')).toBe(false)
    expect(await remaining(oldBalanceId)).toBe('50.00')
  })

  it('cannot be driven below zero, even by a direct write', async () => {
    await rejects(
      () =>
        sql.query(`UPDATE prepaid_balances SET remaining_amount = '-1.00' WHERE id = $1`, [
          oldBalanceId,
        ]),
      'prepaid_balances_remaining_in_range',
    )
  })

  it('cannot be given back more than was ever bought', async () => {
    // The failure mode a naive "put it back" would produce: void twice, and the balance grows
    // past what the client actually paid.
    await rejects(
      () =>
        sql.query(`UPDATE prepaid_balances SET remaining_amount = '50.01' WHERE id = $1`, [
          oldBalanceId,
        ]),
      'prepaid_balances_remaining_in_range',
    )
  })
})

describe('oldest first, across balances', () => {
  it('takes the whole of the older balance and the rest from the newer', async () => {
    // $220 against $50 (older) and $200 (newer).
    const claims = await allocate(22_000)

    expect(claims).toHaveLength(2)
    expect(claims[0].id, 'the 30-day-old balance must be spent first').toBe(oldBalanceId)
    expect(claims[0].cents).toBe(5_000)
    expect(claims[1].id).toBe(newBalanceId)
    expect(claims[1].cents).toBe(17_000)

    expect(await remaining(oldBalanceId)).toBe('0.00')
    expect(await remaining(newBalanceId)).toBe('30.00')
  })

  it('records one draw per balance for a single booking', async () => {
    // The case the original unique index on booking_id alone would have refused, taking the
    // client's money and giving them no appointment.
    await sql.query(
      `INSERT INTO prepaid_redemptions (prepaid_balance_id, booking_id, amount_applied)
       VALUES ($1, $3, '50.00'), ($2, $3, '170.00')`,
      [oldBalanceId, newBalanceId, bookingId],
    )

    const rows = (await sql.query(
      `SELECT sum(amount_applied)::numeric(10,2) AS total, count(*)::int AS n
         FROM prepaid_redemptions WHERE booking_id = $1`,
      [bookingId],
    )) as { total: string; n: number }[]

    expect(rows[0].n).toBe(2)
    expect(rows[0].total).toBe('220.00')
  })

  it('still refuses the same balance twice for the same booking', async () => {
    // Loosening the index to (booking, balance) must not have given up the double-spend guard.
    await rejects(
      () =>
        sql.query(
          `INSERT INTO prepaid_redemptions (prepaid_balance_id, booking_id, amount_applied)
           VALUES ($1, $2, '1.00')`,
          [oldBalanceId, bookingId],
        ),
      'prepaid_redemptions_booking_id_prepaid_balance_id_index',
    )
  })

  it('refuses a draw of nothing', async () => {
    await rejects(
      () =>
        sql.query(
          `INSERT INTO prepaid_redemptions (prepaid_balance_id, booking_id, amount_applied)
           VALUES ($1, $2, '0.00')`,
          [newBalanceId, bookingId],
        ),
      'prepaid_redemptions_amount_positive',
    )
  })
})

describe('cancelling gives the money back', () => {
  it('voids every draw and restores each balance exactly once', async () => {
    const undone = (await sql.query(
      `WITH voided AS (
         UPDATE prepaid_redemptions SET voided_at = now()
          WHERE booking_id = $1 AND voided_at IS NULL
         RETURNING prepaid_balance_id, amount_applied
       ),
       restored AS (
         UPDATE prepaid_balances b
            SET remaining_amount = b.remaining_amount + v.amount_applied, status = 'active'
           FROM voided v
          WHERE b.id = v.prepaid_balance_id
         RETURNING b.id
       )
       SELECT count(*)::int AS n FROM restored`,
      [bookingId],
    )) as { n: number }[]

    expect(undone[0].n, 'both balances should have been restored').toBe(2)
    expect(await remaining(oldBalanceId)).toBe('50.00')
    expect(await remaining(newBalanceId)).toBe('200.00')
  })

  it('is harmless when clicked twice', async () => {
    // `voided_at IS NULL` is the whole guard. Without it the balance grows every time somebody
    // presses cancel again.
    const again = (await sql.query(
      `WITH voided AS (
         UPDATE prepaid_redemptions SET voided_at = now()
          WHERE booking_id = $1 AND voided_at IS NULL
         RETURNING prepaid_balance_id, amount_applied
       ),
       restored AS (
         UPDATE prepaid_balances b
            SET remaining_amount = b.remaining_amount + v.amount_applied, status = 'active'
           FROM voided v
          WHERE b.id = v.prepaid_balance_id
         RETURNING b.id
       )
       SELECT count(*)::int AS n FROM restored`,
      [bookingId],
    )) as { n: number }[]

    expect(again[0].n, 'a second cancel must restore nothing').toBe(0)
    expect(await remaining(oldBalanceId)).toBe('50.00')
    expect(await remaining(newBalanceId)).toBe('200.00')
  })
})

describe('partial cover', () => {
  it('leaves the shortfall to be collected, not silently forgiven', async () => {
    // $250 service against $50 + $200 held: everything goes, and nothing is left owing.
    const claims = await allocate(25_000)
    const applied = claims.reduce((sum, c) => sum + c.cents, 0)
    expect(applied).toBe(25_000)

    await sql.query(
      `UPDATE prepaid_balances SET remaining_amount = original_amount WHERE client_id = $1`,
      [clientId],
    )

    // Now the case Keoni described: $180 held against a $250 service.
    await sql.query(
      `UPDATE prepaid_balances SET remaining_amount = '0.00' WHERE id = $1`,
      [newBalanceId],
    )
    await sql.query(
      `UPDATE prepaid_balances SET remaining_amount = '180.00', original_amount = '180.00'
        WHERE id = $1`,
      [oldBalanceId],
    )

    const short = await allocate(25_000)
    const covered = short.reduce((sum, c) => sum + c.cents, 0)

    expect(covered).toBe(18_000)
    expect(25_000 - covered, 'the remainder must be exactly the shortfall').toBe(7_000)
    expect(await remaining(oldBalanceId)).toBe('0.00')
  })
})
