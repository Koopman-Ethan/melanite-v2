import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getOwedByProvider } from '@/lib/db/queries/revenue'

// What providers are holding on Melanite's behalf.
//
// A Groupon voucher, cash or a cheque is handed to the PROVIDER, who keeps the whole amount.
// Melanite's half is therefore not a payout waiting to be sent but a debt waiting to be
// collected — the only direction of money in the system that nothing automatic resolves.
//
// Measured as a DELTA against whatever is already outstanding, never against an assumed empty
// table. Writing this the other way produced a confident wrong answer once already: the figure
// looked too high, and the cause was a real booking somebody had made, not the query.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
const made: string[] = []

const at = (hour: number) => new Date(Date.UTC(2092, 5, 9, hour)).toISOString()

async function external(method: string, price: string, hour: number) {
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        external_method, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, 'ZZ Owed', $3, $3, 'external', $4::payment_method, 60, $5, $6, 'upcoming')
     RETURNING id`,
    [providerId, providerServiceId, price, method, at(hour), at(hour + 1)],
  )) as { id: string }[]
  made.push(rows[0].id)
  return rows[0].id
}

/** Melanite's outstanding total for our provider, right now. */
async function owedNow(): Promise<number> {
  const row = (await getOwedByProvider()).find((r) => r.providerId === providerId)
  return Number(row?.owed ?? 0)
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
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
})

describe('what a provider owes Melanite', () => {
  it('counts half of a Groupon booking', async () => {
    const before = await owedNow()
    await external('groupon', '200.00', 1)
    expect(await owedNow()).toBeCloseTo(before + 100, 2)
  })

  it('counts cash and cheques the same way', async () => {
    const before = await owedNow()
    await external('cash', '150.00', 3)
    await external('check', '50.00', 5)
    expect(await owedNow()).toBeCloseTo(before + 100, 2)
  })

  it('EXCLUDES Cherry, because that money never reached the provider', async () => {
    // The one that runs the other way: Cherry pays Melanite directly and Melanite owes the
    // provider their half. Counting it here would put somebody on a collections list for money
    // they never held. Cherry is no longer offered on a booking at all, but the enum still
    // permits it and imported v1 rows may carry it.
    const before = await owedNow()
    await external('cherry', '900.00', 7)
    expect(await owedNow()).toBeCloseTo(before, 2)
  })

  it('drops off the moment the payment is recorded', async () => {
    // Recording IS the act of saying "collected". If it did not clear, the list would grow
    // forever and stop being read.
    const id = await external('groupon', '300.00', 9)
    const withIt = await owedNow()

    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
          tip_amount, provider_payout, melanite_cut, payment_method, payout_status)
       VALUES ('booking', 'client', 'purchase', 'booking', $1, $2, '300.00', '0.00', '150.00',
               '150.00', 'groupon', 'paid')`,
      [id, providerId],
    )

    expect(await owedNow()).toBeCloseTo(withIt - 150, 2)
  })

  it('ignores a cancelled appointment', async () => {
    // Nobody owes anything for a treatment that did not happen.
    const before = await owedNow()
    const id = await external('groupon', '400.00', 11)
    await sql.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [id])
    expect(await owedNow()).toBeCloseTo(before, 2)
  })

  it('ignores a booking paid by card', async () => {
    // A card payment splits at Stripe. There is nothing to collect and never was.
    const before = await owedNow()
    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price, payment_source,
          duration_mins, start_time, end_time, status)
       VALUES ($1, $2, 'ZZ Owed Card', '250.00', '250.00', 'checkout_link', 60, $3, $4, 'upcoming')
       RETURNING id`,
      [providerId, providerServiceId, at(13), at(14)],
    )) as { id: string }[]
    made.push(rows[0].id)

    expect(await owedNow()).toBeCloseTo(before, 2)
  })
})
