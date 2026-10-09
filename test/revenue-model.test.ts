import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { providerRevenueModel } from '@/lib/db/schema'
import { chargeRentalFee } from '@/lib/rental/charge'
import {
  isHouse,
  notHouse,
  paysRent,
  revenueModelLabel,
  sharesRevenue,
  type RevenueModel,
} from '@/lib/revenue-model'

// Which billing model a provider is on, and the one mistake that must never happen.
//
// Three models coexist from October 2026: `rental` (flat fee for the laser, the default and
// everybody new), `split` (the original 50/50, closed, and kept for Leyla, Brittany and Karly
// because Keoni judged she would lose them otherwise), and `house` (Melanite itself).
//
// THE FAILURE THIS FILE EXISTS TO CATCH is a grandfathered provider leaking into the rental
// machinery: Karly charged $30 rent for the laser AND Melanite taking $25 of her $50. Charged
// twice, for one session, with nothing erroring. Every rental gate used to be written as
// `revenueModel !== 'house'`, which meant exactly "pays rent" right up until a third value
// existed and then silently meant something catastrophic.
//
// So the assertions below are about PARTITIONING. Every provider belongs to exactly one model,
// the predicates agree about which, and the SQL fragments agree with the predicates against real
// rows. A fourth model added without thought fails here rather than in somebody's bank account.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const ALL = providerRevenueModel.enumValues

describe('the models partition cleanly', () => {
  it('puts every model in exactly one of rent, share or house', () => {
    // The invariant the whole design rests on. Two true means somebody is billed twice; none
    // true means somebody is billed not at all, which is the quieter and more expensive bug.
    for (const model of ALL) {
      const bucket = [paysRent(model), sharesRevenue(model), isHouse(model)].filter(Boolean)
      expect(bucket.length, `${model} belongs to ${bucket.length} models, should be 1`).toBe(1)
    }
  })

  it('never says a provider both pays rent and shares revenue', () => {
    // Stated separately from the partition because this is the specific pair that costs money,
    // and a future reader should see it asserted in its own right.
    for (const model of ALL) {
      expect(paysRent(model) && sharesRevenue(model), `${model} does both`).toBe(false)
    }
  })

  it('agrees with itself about the house', () => {
    for (const model of ALL) {
      expect(notHouse(model)).toBe(!isHouse(model))
    }
  })

  it('handles every value the enum can hold', () => {
    // The `never` default throws, so an enum value added without updating the switches fails
    // here. That is the intended way to find out: a compiler error for typed call sites, and
    // this test for the handful that come from the database as strings.
    for (const model of ALL) {
      expect(() => paysRent(model)).not.toThrow()
      expect(() => sharesRevenue(model)).not.toThrow()
      expect(() => revenueModelLabel(model)).not.toThrow()
    }
  })

  it('knows what the three models are, so adding one is deliberate', () => {
    // Deliberately brittle. A new model should make somebody read this file.
    expect([...ALL].sort()).toEqual(['house', 'rental', 'split'])
  })

  it('refuses a value that is not a model at all', () => {
    expect(() => paysRent('freeloader' as RevenueModel)).toThrow(/unhandled revenue model/i)
  })
})

describe('the SQL fragments agree with the predicates', () => {
  it('buckets every real provider exactly once', async () => {
    // The predicates are used in TypeScript and the fragments in queries, and nothing but this
    // test makes the two agree. A fragment that disagrees returns the wrong ROWS rather than
    // failing, which is why it is checked against real data rather than reasoned about.
    const [row] = (await sql.query(
      `SELECT count(*)::int                                            AS total,
              count(*) filter (where revenue_model = 'rental')::int     AS rent,
              count(*) filter (where revenue_model = 'split')::int      AS share,
              count(*) filter (where revenue_model = 'house')::int      AS house,
              count(*) filter (where revenue_model <> 'house')::int     AS not_house
         FROM providers`,
    )) as Record<string, number>[]

    expect(row.rent + row.share + row.house).toBe(row.total)
    expect(row.rent + row.share).toBe(row.not_house)

    // And the predicates reach the same totals from the other direction.
    const rows = (await sql.query(`SELECT revenue_model FROM providers`)) as {
      revenue_model: RevenueModel
    }[]
    expect(rows.filter((r) => paysRent(r.revenue_model)).length).toBe(row.rent)
    expect(rows.filter((r) => sharesRevenue(r.revenue_model)).length).toBe(row.share)
    expect(rows.filter((r) => notHouse(r.revenue_model)).length).toBe(row.not_house)
  })
})

// ---------------------------------------------------------------------------------------------
// The money assertion
// ---------------------------------------------------------------------------------------------

let splitProviderId = ''
let splitServiceId = ''
const madeBookings: string[] = []

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'split' LIMIT 1`,
  )) as { id: string }[]
  if (!prov) throw new Error('no split provider in dev — the grandfathered three should exist')
  splitProviderId = prov.id

  const [svc] = (await sql.query(
    `SELECT id FROM services WHERE name = 'Laser Hair Removal — Chin'`,
  )) as { id: string }[]

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [splitProviderId, svc.id],
  )) as { id: string }[]

  splitServiceId =
    existing[0]?.id ??
    (
      (await sql.query(
        `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
         VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
        [splitProviderId, svc.id],
      )) as { id: string }[]
    )[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [madeBookings])
  await sql.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [madeBookings])
})

describe('a grandfathered provider is never charged rent', () => {
  it('refuses to charge one, even for a booking marked rental', async () => {
    // Belt and braces, and the single most important assertion in this file.
    //
    // A split provider should never HAVE a rental booking — the booking path branches long
    // before here. But "should never" is how the double-charge happens, so the charger itself
    // refuses rather than trusting its callers. Karly being billed $30 for the laser on top of
    // Melanite taking $25 of her $50 is the outcome, and it is the thing Keoni was afraid of.
    let bookingId = ''
    for (let back = 900; back < 1100; back += 2) {
      try {
        const rows = (await sql.query(
          `INSERT INTO bookings
             (provider_id, provider_service_id, original_price, price, payment_source,
              duration_mins, start_time, end_time, status)
           VALUES ($1, $2, '0.00', '0.00', 'rental', 60,
                   now() - ($3::int || ' hours')::interval,
                   now() - (($3::int - 1) || ' hours')::interval, 'completed')
           RETURNING id`,
          [splitProviderId, splitServiceId, String(back)],
        )) as { id: string }[]
        bookingId = rows[0].id
        madeBookings.push(bookingId)
        break
      } catch (err) {
        const e = err as { cause?: { code?: string }; code?: string }
        if ((e.code ?? e.cause?.code) !== '23P01') throw err
      }
    }
    expect(bookingId, 'could not place a fixture booking').not.toBe('')

    const out = await chargeRentalFee(bookingId)

    expect(out, 'a split provider must never be charged rent').not.toHaveProperty('charged')
    expect(out).toHaveProperty('skipped')
    // And says why in its own terms. The house skip and this one are different situations —
    // one is normal, one means a gate was missed — so they must not share a message.
    if ('skipped' in out) expect(out.skipped).toMatch(/50\/50/)

    // And nothing recorded. A skip that still writes a ledger row would make the books say
    // Melanite earned rent it never took.
    const [led] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = $1 AND source = 'rental_fee'`,
      [bookingId],
    )) as { n: number }[]
    expect(led.n).toBe(0)
  })
})
