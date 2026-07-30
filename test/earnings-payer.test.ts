import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getEarningsTotals, getRecentPayouts } from '@/lib/db/queries/earnings'

// Whose money is it?
//
// `provider_id` on a ledger row means "the provider this row concerns" — which is NOT the same
// as "the provider who earned it". A membership charge, a day's room rental and an Epicutis
// subscription all carry a provider's id and all describe money going the other way.
//
// The distinction is the `payer` column, and the schema states the rule directly:
// `provider charges = SUM(gross_amount) WHERE payer = 'provider'`.
//
// Getting it wrong put a provider's own bills on their earnings page, each showing a $0.00
// share. Nothing was miscalculated — the totals were right — but the page said "here is what
// you earned" above a list of things they had been charged for.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
const made: string[] = []

/** The subject each source hangs off. Not decoration — `subject_type` is an enum, so a wrong
 *  value is rejected rather than stored, which is the schema refusing to hold a row that
 *  describes nothing. */
const SUBJECT: Record<string, string> = {
  booking: 'booking',
  package: 'client_package',
  room_rental: 'room_booking',
  membership: 'membership',
  epicutis: 'membership',
}

async function entry(opts: {
  source: string
  payer: string
  gross: string
  payout: string
  cut: string
}) {
  const rows = (await sql.query(
    `INSERT INTO ledger_entries
       (source, payer, entry_type, subject_type, subject_id, provider_id, gross_amount,
        tip_amount, provider_payout, melanite_cut, payment_method, payout_status)
     VALUES ($1, $2::ledger_payer, 'purchase', $3::ledger_subject_type, gen_random_uuid(), $4,
             $5, '0.00', $6, $7, 'cash', 'paid')
     RETURNING id`,
    [
      opts.source,
      opts.payer,
      SUBJECT[opts.source],
      providerId,
      opts.gross,
      opts.payout,
      opts.cut,
    ],
  )) as { id: string }[]
  made.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id FROM providers WHERE status = 'active' ORDER BY email LIMIT 1`,
  )) as { id: string }[]
  providerId = rows[0].id
})

afterAll(async () => {
  for (const id of made) await sql.query(`DELETE FROM ledger_entries WHERE id = $1`, [id])
})

describe('the earnings list shows earnings, not bills', () => {
  it('includes a booking the client paid for', async () => {
    const id = await entry({
      source: 'booking',
      payer: 'client',
      gross: '200.00',
      payout: '100.00',
      cut: '100.00',
    })
    const rows = await getRecentPayouts(providerId, 200)
    expect(rows.some((r) => r.id === id)).toBe(true)
  })

  it('excludes the three things a provider pays Melanite for', async () => {
    // The exact rows that showed up on the real page: a $150 medical-direction charge, a $60
    // room rental and a $95 Epicutis subscription. All carry the provider's id; none is income.
    const ids = []
    for (const source of ['membership', 'room_rental', 'epicutis']) {
      ids.push(
        await entry({
          source,
          payer: 'provider',
          gross: '95.00',
          payout: '0.00',
          // A provider charge is Melanite's in full — the CHECK constraint enforces exactly
          // this, so an entry shaped any other way could not exist to be filtered.
          cut: '95.00',
        }),
      )
    }

    const rows = await getRecentPayouts(providerId, 200)
    for (const id of ids) {
      expect(rows.some((r) => r.id === id), `provider-paid entry ${id} must not appear`).toBe(false)
    }
  })

  it('leaves the totals alone', async () => {
    // The totals were always right, because they filter by source rather than by payer. This
    // is here so a future change to one filter cannot quietly disagree with the other.
    const totals = await getEarningsTotals(providerId)
    const rows = await getRecentPayouts(providerId, 200)

    const listed = rows
      .filter((r) => r.source === 'booking' && r.entryType === 'purchase')
      .reduce((sum, r) => sum + Number(r.payout), 0)

    expect(Number(totals.earnedLifetime)).toBeGreaterThanOrEqual(listed - 0.001)
  })

  it('a package sale still counts, because the provider was paid for it', async () => {
    // Prepaid, not yet earned — but it IS their money, and it belongs on the list. The
    // earned/prepaid separation is the totals' job, not this filter's.
    const id = await entry({
      source: 'package',
      payer: 'client',
      gross: '600.00',
      payout: '300.00',
      cut: '300.00',
    })
    const rows = await getRecentPayouts(providerId, 200)
    expect(rows.some((r) => r.id === id)).toBe(true)
  })
})
