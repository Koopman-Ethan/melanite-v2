import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Two clients cannot be in the chair at once.
//
// There is one laser. Every provider shares it, and the booking path guarded that with
// `INSERT ... SELECT ... WHERE NOT EXISTS (overlapping booking)` — which reads as airtight and
// is not. Under READ COMMITTED two concurrent statements each evaluate NOT EXISTS against a
// snapshot that cannot see the other's uncommitted row, so both find the slot free and both
// insert. room_bookings has had an EXCLUDE constraint since migration 0008; the laser, the more
// valuable resource, had nothing until 0013.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
const CLIENT = `ZZ OCCUPANCY ${Date.now()}`

/** Far enough out that it cannot collide with anything real. */
const at = (hourOffset: number) =>
  new Date(Date.UTC(2098, 5, 12, 15 + hourOffset, 0, 0)).toISOString()

async function book(startIso: string, endIso: string, status = 'upcoming') {
  return sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        duration_mins, start_time, end_time, status)
     VALUES ($1, $2, $3, '100.00', '100.00', 'checkout_link', 60, $4::timestamptz,
             $5::timestamptz, $6::booking_status)
     RETURNING id`,
    [providerId, providerServiceId, CLIENT, startIso, endIso, status],
  )
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerServiceId = rows[0].id
  providerId = rows[0].provider_id
})

afterAll(async () => {
  await sql.query(`DELETE FROM bookings WHERE client_name = $1`, [CLIENT])
})

describe('laser occupancy', () => {
  it('refuses a second booking overlapping the first', async () => {
    await book(at(0), at(1))
    await expect(book(at(0), at(1))).rejects.toThrow()
  })

  it('refuses a partial overlap, not just an exact match', async () => {
    // Half an hour into an existing hour. A uniqueness rule on (date, time) would allow this;
    // an overlap rule does not.
    const start = new Date(Date.parse(at(0)) + 30 * 60_000).toISOString()
    const end = new Date(Date.parse(at(1)) + 30 * 60_000).toISOString()
    await expect(book(start, end)).rejects.toThrow()
  })

  it('allows a booking that starts exactly when the last one ends', async () => {
    // Ranges are half-open, so back-to-back appointments are fine. Getting this wrong would
    // block a full day of legitimate bookings.
    const created = (await book(at(1), at(2))) as { id: string }[]
    expect(created).toHaveLength(1)
  })

  it('lets a cancelled slot be resold', async () => {
    const [row] = (await book(at(5), at(6))) as { id: string }[]
    await sql.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [row.id])

    // Cancelled and no-show rows do not occupy the laser. If they did, every cancellation
    // would take the slot off the market permanently.
    const resold = (await book(at(5), at(6))) as { id: string }[]
    expect(resold).toHaveLength(1)
  })

  it('holds under concurrent attempts on the same slot', async () => {
    // The case the old NOT EXISTS could not survive: eight simultaneous inserts, one winner.
    const attempts = Array.from({ length: 8 }, () =>
      book(at(10), at(11)).then(
        () => 'booked' as const,
        () => 'refused' as const,
      ),
    )
    const results = await Promise.all(attempts)

    expect(results.filter((r) => r === 'booked')).toHaveLength(1)
    expect(results.filter((r) => r === 'refused')).toHaveLength(7)
  })
})
