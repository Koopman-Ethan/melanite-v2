import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDigestDay, toCollectCents } from '@/lib/db/queries/daily-digest'
import { denverInstant } from '@/lib/db/queries/availability'

// One evening, read back out of the database.
//
// Measured as a DELTA against whatever that day already holds, never against an assumed empty
// table — the same rule `owed-by-provider.test.ts` records learning the hard way. The fixtures
// sit on a far-future date so the delta is almost always from zero, but the assertions do not
// depend on that being true.
//
// Times are built with `denverInstant`, not raw `Date.UTC`, because the thing under test IS the
// Denver day window. Constructing fixtures a different way than the query constructs its bounds
// would let a timezone bug pass.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const DAY = '2092-06-09'
const PREV = '2092-06-08'

let providerId = ''
let providerServiceId = ''
const made: string[] = []

// There is one laser, and `bookings_no_overlap` enforces it. Every fixture therefore needs its
// own slot: without this the second insert in a file fails on the exclusion constraint, which
// looks like a query bug and is not one.
let nextHour = 8

/** An external booking at a Denver wall-clock time on `day`. */
async function booking(options: {
  method: string | null
  price: string
  day?: string
  time?: string
  status?: string
  paymentSource?: string
}) {
  const {
    method,
    price,
    day = DAY,
    time = `${String(nextHour++).padStart(2, '0')}:00`,
    status = 'completed',
  } = options
  const start = denverInstant(day, time)
  const end = new Date(start.getTime() + 60 * 60 * 1000)

  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        external_method, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, 'ZZ Digest', $3, $3, $4, $5::payment_method, 60, $6, $7, $8)
     RETURNING id`,
    [
      providerId,
      providerServiceId,
      price,
      options.paymentSource ?? 'external',
      method,
      start.toISOString(),
      end.toISOString(),
      status,
    ],
  )) as { id: string }[]

  made.push(rows[0].id)
  return rows[0].id
}

/** Records the payment, which is the only way an appointment stops being outstanding. */
async function recordPayment(bookingId: string, price: string) {
  const half = (Number(price) / 2).toFixed(2)
  await sql.query(
    `INSERT INTO ledger_entries
       (source, payer, entry_type, subject_type, subject_id, provider_id,
        gross_amount, provider_payout, melanite_cut, payment_method, payout_status)
     VALUES ('booking', 'client', 'purchase', 'booking', $1, $2, $3, $4, $4, 'groupon', 'paid')`,
    [bookingId, providerId, price, half],
  )
}

/** What that day looks like right now. */
async function dayNow() {
  const data = await getDigestDay(DAY)
  const owed = data.appointments.reduce(
    (sum, a) => sum + toCollectCents(a, data.providerSharePct),
    0,
  )
  return { count: data.appointments.length, cancelled: data.cancelled, owedCents: owed }
}

beforeAll(async () => {
  // A SPLIT provider, not the house one: a house appointment is deliberately worth nothing to
  // collect, which would make the money assertions below pass for the wrong reason.
  const rows = (await sql.query(
    `SELECT ps.id, ps.provider_id
       FROM provider_services ps
       JOIN providers p ON p.id = ps.provider_id
      WHERE ps.is_active AND p.revenue_model = 'split'
      LIMIT 1`,
  )) as { id: string; provider_id: string }[]

  providerServiceId = rows[0].id
  providerId = rows[0].provider_id
})

afterAll(async () => {
  for (const id of made) {
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
})

describe('the appointments on one Denver day', () => {
  it('lists a Groupon booking and asks for half of it', async () => {
    const before = await dayNow()
    await booking({ method: 'groupon', price: '200.00' })
    const after = await dayNow()

    expect(after.count).toBe(before.count + 1)
    expect(after.owedCents).toBe(before.owedCents + 10000)
  })

  it('stops asking once the payment is recorded', async () => {
    const before = await dayNow()
    const id = await booking({ method: 'cash', price: '80.00' })
    expect((await dayNow()).owedCents).toBe(before.owedCents + 4000)

    await recordPayment(id, '80.00')

    const after = await dayNow()
    // Still on the list — it is part of the day — but no longer money to chase.
    expect(after.count).toBe(before.count + 1)
    expect(after.owedCents).toBe(before.owedCents)
  })

  it('asks for nothing on a Cherry booking, where the debt runs the other way', async () => {
    const before = await dayNow()
    await booking({ method: 'cherry', price: '500.00' })
    const after = await dayNow()

    expect(after.count).toBe(before.count + 1)
    expect(after.owedCents).toBe(before.owedCents)
  })

  it('counts a cancellation rather than listing it', async () => {
    const before = await dayNow()
    await booking({ method: 'groupon', price: '150.00', status: 'cancelled' })
    const after = await dayNow()

    expect(after.count).toBe(before.count)
    expect(after.cancelled).toBe(before.cancelled + 1)
    expect(after.owedCents).toBe(before.owedCents)
  })

  it('uses the Denver day, not the UTC one', async () => {
    // The assertion this whole file exists for, checked in BOTH directions. Denver in June is
    // UTC-6, so the Denver day runs 06:00 UTC to 06:00 UTC — a window built on UTC midnight is
    // shifted six hours and gets each end wrong in the opposite direction.
    const before = await dayNow()

    // 23:45 Denver is 05:45 UTC the NEXT morning. A UTC window drops it; this one must not.
    await booking({ method: 'groupon', price: '100.00', time: '23:45' })
    expect((await dayNow()).count).toBe(before.count + 1)

    // 19:00 Denver the evening BEFORE is 01:00 UTC on the day itself. A UTC window picks it up;
    // this one must not.
    await booking({ method: 'groupon', price: '100.00', day: PREV, time: '19:00' })
    expect((await dayNow()).count).toBe(before.count + 1)
  })

  it('reports the platform share it actually computed with', async () => {
    const data = await getDigestDay(DAY)
    expect(data.providerSharePct).toBeGreaterThan(0)
    expect(data.providerSharePct).toBeLessThan(1)
    expect(data.day).toBe(DAY)
  })
})
