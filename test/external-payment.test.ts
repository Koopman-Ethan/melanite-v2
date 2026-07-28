import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Bookings paid outside the app — Groupon, Cherry, cash, a card in person.
//
// v1 could not record any of this, and the cost is measurable: four of its five real
// appointments have money nobody wrote down, $600 that only exists as a memory. The whole
// point of these fields is that Keoni can answer "what am I owed, and by whom" from the app
// rather than from a conversation.
//
// The direction of the money is what makes it interesting. A Stripe booking pays the provider
// automatically through a destination charge. A Groupon voucher is collected BY the provider,
// so Melanite's half becomes something Keoni has to invoice back — which she can only do if
// she knows the amount, which is why the provider states it at booking.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
const made: string[] = []

const at = (hour: number) => new Date(Date.UTC(2095, 7, 8, hour)).toISOString()

async function book(opts: { source: string; method: string | null; hour: number; price?: string }) {
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        external_method, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, 'ZZ External', $3, $3, $4::booking_payment_source,
             $5::payment_method, 60, $6::timestamptz, $7::timestamptz, 'upcoming')
     RETURNING id`,
    [
      providerId,
      providerServiceId,
      opts.price ?? '200.00',
      opts.source,
      opts.method,
      at(opts.hour),
      at(opts.hour + 1),
    ],
  )) as { id: string }[]
  made.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerServiceId = rows[0].id
  providerId = rows[0].provider_id
})

afterAll(async () => {
  for (const id of made) {
    await sql.query(`DELETE FROM checkout_links WHERE booking_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
})

describe('the route and the method must agree', () => {
  it('accepts an external booking that names its method', async () => {
    const id = await book({ source: 'external', method: 'groupon', hour: 1 })
    const [row] = (await sql.query(
      `SELECT payment_source, external_method FROM bookings WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    expect(row.payment_source).toBe('external')
    expect(row.external_method).toBe('groupon')
  })

  it('refuses an external booking with no method', async () => {
    // "Paid outside the app" without saying how is not a record of anything. Keoni cannot
    // invoice a share of a payment she cannot identify.
    await expect(book({ source: 'external', method: null, hour: 2 })).rejects.toThrow()
  })

  it('refuses a method on a booking that is not external', async () => {
    // A checkout link that also claims to be Groupon is two contradictory answers, and the
    // reconciliation queue would show it as both.
    await expect(book({ source: 'checkout_link', method: 'groupon', hour: 3 })).rejects.toThrow()
  })

  it('leaves the ordinary route alone', async () => {
    const id = await book({ source: 'checkout_link', method: null, hour: 4 })
    const [row] = (await sql.query(`SELECT external_method FROM bookings WHERE id = $1`, [
      id,
    ])) as Record<string, string | null>[]
    expect(row.external_method).toBeNull()
  })

  it('accepts every method the ledger understands', async () => {
    // The same enum both places, so "Groupon" means one thing in the app rather than two
    // spellings that drift.
    let hour = 10
    for (const method of ['groupon', 'cherry', 'cash', 'check', 'other']) {
      const id = await book({ source: 'external', method, hour: hour++ })
      expect(id).toBeTruthy()
    }
  })
})

describe('Keoni can find them', () => {
  it('an external booking with no ledger entry appears as unpaid', async () => {
    // The hole this feature exists to close, which the query itself very nearly reproduced:
    // getUnpaidBookings filtered on payment_source = 'checkout_link', so a provider marking a
    // booking as Groupon would have filed it somewhere nobody looks.
    const id = await book({ source: 'external', method: 'groupon', hour: 20, price: '175.00' })

    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM bookings b
        WHERE b.id = $1
          AND b.payment_source IN ('checkout_link', 'external')
          AND b.status <> 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries l
             WHERE l.subject_type = 'booking' AND l.subject_id = b.id
          )`,
      [id],
    )) as { n: number }[]

    expect(row.n, 'external booking must reach the reconciliation queue').toBe(1)
  })

  it('carries the amount the provider stated', async () => {
    // Not decoration. It is the figure Keoni invoices a share of, and for Groupon it is rarely
    // the list price — which is exactly why the provider is asked rather than assumed.
    const id = await book({ source: 'external', method: 'groupon', hour: 21, price: '75.00' })
    const [row] = (await sql.query(
      `SELECT price, external_method FROM bookings WHERE id = $1`,
      [id],
    )) as Record<string, string>[]

    expect(row.price).toBe('75.00')
    expect(row.external_method).toBe('groupon')
  })

  it('has no checkout link, so nobody can pay twice', async () => {
    const id = await book({ source: 'external', method: 'cash', hour: 22 })
    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM checkout_links WHERE booking_id = $1`,
      [id],
    )) as { n: number }[]
    expect(row.n).toBe(0)
  })
})
