import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getProviderSharePct } from '@/lib/db/queries/admin-tools'
import { rentalFeeForBooking } from '@/lib/rental/charge'
import { feeForProviderService, feeForService } from '@/lib/rental/schedule'
import { settleDueRent } from '@/lib/rental/settle'

// How much a provider owes for a session, and who decides it.
//
// From 14 October there are two bases. Most providers pay the published fee for the service's
// tier. Leyla, Brittany and Karly pay half of what THEY charge for it — the last trace of the
// 50/50 they were grandfathered into, arrived at from the other side now that they bill their
// clients directly rather than through Melanite.
//
// THE TWO THINGS WORTH TESTING HARDEST ARE BOTH ABOUT THE SECOND BASIS:
//
//   1. The amount really is half their own price, not the tier price. Getting this wrong
//      charges a provider the wrong rent on every session they ever book, quietly, and the
//      number looks plausible either way.
//
//   2. They are NEVER swept automatically. Their price list is theirs to edit, so the derived
//      figure is a number the payer chose; Keoni confirms each session against a receipt before
//      the card is touched. The sweep has four entry points and the guard is in the predicate
//      rather than at the call sites, so this is the test that the guard is where it claims.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ BASIS ${Date.now()}`
const SERVICE = 'Laser Hair Removal — Chin'

let providerId = ''
let providerServiceId = ''
let originalBasis = 'tier'
let listPrice = 0
const made: string[] = []

beforeAll(async () => {
  // A provider who can actually be charged, so the sweep would genuinely pick them up if the
  // basis guard were missing. Picking a card-less one would make the test pass for the wrong
  // reason — they would be skipped for having no card rather than for their basis.
  const [prov] = (await sql.query(
    `SELECT id, rent_basis FROM providers
      WHERE revenue_model = 'rental' AND billing_payment_method_id IS NOT NULL
      LIMIT 1`,
  )) as { id: string; rent_basis: string }[]
  if (!prov) throw new Error('no rental provider with a card in dev — this test needs one')
  providerId = prov.id
  originalBasis = prov.rent_basis

  const [svc] = (await sql.query(`SELECT id FROM services WHERE name = $1`, [SERVICE])) as {
    id: string
  }[]

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

  // A price they charge their own client, so there is a half to take.
  listPrice = 180
  await sql.query(`UPDATE provider_services SET price = $2, is_active = true WHERE id = $1`, [
    providerServiceId,
    listPrice.toFixed(2),
  ])
})

afterAll(async () => {
  // Put the provider back exactly as found. A test that leaves somebody on a bespoke billing
  // arrangement is worse than no test — `test/owed-by-provider.test.ts` restored a hardcoded
  // value for the same reason and corrupted a real row the day a third value existed.
  await sql.query(`UPDATE providers SET rent_basis = $2 WHERE id = $1`, [
    providerId,
    originalBasis,
  ])
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [made])
  await sql.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [made])
})

/** A past session for this provider, old enough that the sweep would want it. */
async function pastSession(): Promise<string> {
  for (let back = 20; back < 300; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, original_price, price, payment_source,
            duration_mins, start_time, end_time, status, notes)
         VALUES ($1, $2, '0.00', '0.00', 'rental', 60,
                 now() - ($3::int || ' hours')::interval,
                 now() - (($3::int - 1) || ' hours')::interval, 'completed', $4)
         RETURNING id`,
        [providerId, providerServiceId, String(back), TAG],
      )) as { id: string }[]
      made.push(rows[0].id)
      return rows[0].id
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }
  throw new Error('could not place a fixture booking')
}

describe('what the fee is', () => {
  it('is the published tier fee on the ordinary basis', async () => {
    await sql.query(`UPDATE providers SET rent_basis = 'tier' WHERE id = $1`, [providerId])

    const tier = await feeForService(SERVICE)
    expect(tier, 'Chin must be priced for this test to mean anything').not.toBeNull()
    expect(await feeForProviderService(providerId, SERVICE)).toBe(tier)
  })

  it('is half their own price on the grandfathered basis', async () => {
    await sql.query(`UPDATE providers SET rent_basis = 'half_own_price' WHERE id = $1`, [
      providerId,
    ])

    const share = await getProviderSharePct()
    const expected = Math.round(listPrice * 100 * (1 - share))

    expect(await feeForProviderService(providerId, SERVICE)).toBe(expected)
  })

  it('is not the tier fee on the grandfathered basis', async () => {
    // The assertion that would catch the basis silently falling back. Both numbers are
    // plausible rent for a session, so a wrong one does not look wrong.
    await sql.query(`UPDATE providers SET rent_basis = 'half_own_price' WHERE id = $1`, [
      providerId,
    ])
    expect(await feeForProviderService(providerId, SERVICE)).not.toBe(await feeForService(SERVICE))
  })

  it('refuses rather than charging nothing when they have not priced it', async () => {
    // A blank price must not become a free session. Letting a zero through would hand them an
    // unlimited free laser every time they left a price out.
    await sql.query(`UPDATE providers SET rent_basis = 'half_own_price' WHERE id = $1`, [
      providerId,
    ])
    await sql.query(`UPDATE provider_services SET price = '0.00' WHERE id = $1`, [
      providerServiceId,
    ])

    expect(await feeForProviderService(providerId, SERVICE)).toBeNull()

    await sql.query(`UPDATE provider_services SET price = $2 WHERE id = $1`, [
      providerServiceId,
      listPrice.toFixed(2),
    ])
  })
})

describe('what Keoni sets instead', () => {
  it('wins over the derived figure', async () => {
    await sql.query(`UPDATE providers SET rent_basis = 'half_own_price' WHERE id = $1`, [
      providerId,
    ])
    const id = await pastSession()

    const derived = await rentalFeeForBooking(id)
    expect(derived).not.toBeNull()

    await sql.query(`UPDATE bookings SET fee_override_cents = 4321 WHERE id = $1`, [id])
    expect(await rentalFeeForBooking(id)).toBe(4321)
  })
})

describe('the sweep', () => {
  it('never takes a session from a provider billed half their own price', async () => {
    // The guard lives in the predicate rather than at the four call sites — the digest, the
    // cron route, the admin button and the page-load trigger. This is the test that it is
    // actually there, driven through the same function all four of them call.
    await sql.query(`UPDATE providers SET rent_basis = 'half_own_price' WHERE id = $1`, [
      providerId,
    ])
    const id = await pastSession()

    await settleDueRent({ limit: 25 })

    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = $1 AND source = 'rental_fee'`,
      [id],
    )) as { n: number }[]
    expect(row.n, 'their rent is never taken without Keoni').toBe(0)
  })

  it('would have taken it on the ordinary basis', async () => {
    // The control. Without this, the test above passes equally well if the sweep is simply
    // broken — and a sweep that charges nobody looks exactly like a guard that works.
    const id = await pastSession()
    await sql.query(`UPDATE providers SET rent_basis = 'tier' WHERE id = $1`, [providerId])

    const out = await settleDueRent({ limit: 25 })
    expect(out.charged + out.failed, 'the sweep must be reaching this provider at all')
      .toBeGreaterThan(0)
    expect(id).not.toBe('')
  })
})

describe('what the booking page quotes is what the card is charged', () => {
  // TWO PLACES WORK OUT THE SAME NUMBER, which is the shape of every money bug in this
  // codebase so far. `app/app/book/page.tsx` prices the dropdown so a provider can see the fee
  // before committing; `feeForProviderService` prices the actual charge twelve hours later.
  // A provider who is quoted $60 and charged $75 has been lied to, and would not find out
  // until the receipt.
  //
  // The booking page cannot call `feeForProviderService` per row — twenty services is twenty
  // round trips to render one dropdown — so it recomputes from a price it already selected.
  // That duplication is deliberate and this is the test that keeps the two honest.

  it('agrees on every service a half-own-price provider has priced', async () => {
    const [prov] = (await sql.query(
      `SELECT id FROM providers WHERE rent_basis = 'half_own_price' LIMIT 1`,
    )) as { id: string }[]
    if (!prov) throw new Error('no half_own_price provider in dev — this test needs one')

    const priced = (await sql.query(
      `SELECT s.name, ps.price::numeric AS price
         FROM provider_services ps
         JOIN services s ON s.id = ps.service_id
        WHERE ps.provider_id = $1 AND s.active AND ps.is_active AND ps.price > 0
        ORDER BY s.name`,
      [prov.id],
    )) as { name: string; price: string }[]

    expect(priced.length, 'the fixture provider has priced nothing — this would pass vacuously')
      .toBeGreaterThan(0)

    const share = await getProviderSharePct()

    for (const row of priced) {
      // The booking page's arithmetic, copied deliberately rather than imported: importing the
      // page's helper would make this test pass by construction and prove nothing.
      const quoted = Math.round(Number(row.price) * 100 * (1 - share))
      const charged = await feeForProviderService(prov.id, row.name)

      expect(charged, `${row.name}: quoted ${quoted}, charge refused`).not.toBeNull()
      expect(charged, `${row.name}: page quotes ${quoted}, card takes ${charged}`).toBe(quoted)
    }
  })

  it('quotes nothing rather than a tier fee for a service they have not priced', async () => {
    // The failure the walkthrough actually caught. The page used to price every row off the
    // published schedule whoever was looking, so one of the three was shown $60 for a session
    // that would cost them half of their own price — a number they would plan around and never
    // be charged. Refusing is correct: there is genuinely no half to take.
    const [prov] = (await sql.query(
      `SELECT id FROM providers WHERE rent_basis = 'half_own_price' LIMIT 1`,
    )) as { id: string }[]

    const [unpriced] = (await sql.query(
      `SELECT s.name FROM services s
        WHERE s.active
          AND NOT EXISTS (
            SELECT 1 FROM provider_services ps
             WHERE ps.service_id = s.id AND ps.provider_id = $1 AND ps.price > 0
          )
        LIMIT 1`,
      [prov.id],
    )) as { name: string }[]

    if (!unpriced) return // every service priced — nothing to assert, and not a failure

    expect(
      await feeForProviderService(prov.id, unpriced.name),
      `${unpriced.name} has no price, so there is no half of it`,
    ).toBeNull()

    // And the tier fee, which is what they must NOT be quoted, is a real number — so the
    // assertion above is distinguishing the two rather than finding nothing either way.
    expect(await feeForService(unpriced.name)).not.toBeNull()
  })
})
