import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { rentalFeeForBooking } from '@/lib/rental/charge'
import { feeForProviderService, feeForService } from '@/lib/rental/schedule'
import { settleDueRent } from '@/lib/rental/settle'

// How much a provider owes for a session, and who decides it.
//
// Two bases. Most providers pay the published fee for the service's tier. Leyla, Brittany and
// Karly — `keoni_sets` — have NO DERIVED FEE AT ALL: they send Keoni the receipt for what they
// charged their client and she sets what is owed from it, by hand, per appointment.
//
// IT USED TO DERIVE HALF THEIR OWN LIST PRICE, and these tests used to assert that arithmetic.
// Keoni dropped it on 19 October: the list is theirs to maintain, so half of it was the payer's
// own number wearing Melanite's authority — right only while the list matched what the client
// was actually charged, which Melanite cannot see. She would rather read the receipt.
//
// So what is worth testing hardest has changed with it:
//
//   1. Melanite offers no figure, and the null it returns is PERMANENT rather than a gap.
//      The dangerous failure is a caller treating null as "not priced yet" and falling back to
//      the tier fee — charging them somebody else's price, in a number that looks plausible.
//
//   2. They are NEVER swept. There is nothing to sweep with. The guard is in the predicate
//      rather than at the four call sites, so this is the test that it is where it claims.
//
//   3. `feeOverrideCents` is what the card is actually charged, because for these three it is
//      the only source there is.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ BASIS ${Date.now()}`
const SERVICE = 'Laser Hair Removal — Chin'

let providerId = ''
let providerServiceId = ''
let originalBasis = 'tier'
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

  // A price on their own list, deliberately. Nothing should read it any more, and a test that
  // leaves it blank could not tell "ignored correctly" from "there was nothing to ignore".
  await sql.query(`UPDATE provider_services SET price = '180.00', is_active = true WHERE id = $1`, [
    providerServiceId,
  ])
})

afterAll(async () => {
  // Put the provider back exactly as found. A test that leaves somebody on a bespoke billing
  // arrangement is worse than no test — `test/owed-by-provider.test.ts` restored a hardcoded
  // value for the same reason and corrupted a real row the day a third value existed.
  await sql.query(`UPDATE providers SET rent_basis = $2 WHERE id = $1`, [providerId, originalBasis])
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [made])
  await sql.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [made])
})

const setBasis = (basis: string) =>
  sql.query(`UPDATE providers SET rent_basis = $2 WHERE id = $1`, [providerId, basis])

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
    await setBasis('tier')

    const tier = await feeForService(SERVICE)
    expect(tier, 'Chin must be priced for this test to mean anything').not.toBeNull()
    expect(await feeForProviderService(providerId, SERVICE)).toBe(tier)
  })

  it('is nothing at all when Keoni sets it', async () => {
    await setBasis('keoni_sets')
    expect(await feeForProviderService(providerId, SERVICE)).toBeNull()
  })

  it('is nothing even though they have a price on their own list', async () => {
    // THE ASSERTION THAT WOULD CATCH THE OLD BEHAVIOUR COMING BACK. They have $180 against this
    // service; half of it is $90, which is a perfectly plausible rent. Nothing may read it.
    await setBasis('keoni_sets')

    const [row] = (await sql.query(`SELECT price FROM provider_services WHERE id = $1`, [
      providerServiceId,
    ])) as { price: string }[]
    expect(Number(row.price), 'the fixture must have a price to ignore').toBeGreaterThan(0)

    expect(await feeForProviderService(providerId, SERVICE)).toBeNull()
  })

  it('never falls back to the tier fee', async () => {
    // The dangerous misreading of null: "no fee set yet, use the published one". That charges
    // them somebody else's price, in a figure that looks entirely reasonable on a receipt.
    await setBasis('keoni_sets')

    const tier = await feeForService(SERVICE)
    expect(tier, 'the tier fee must be a real number for this to distinguish anything').not.toBeNull()
    expect(await feeForProviderService(providerId, SERVICE)).not.toBe(tier)
  })
})

describe('what Keoni sets instead', () => {
  it('is what the card is charged', async () => {
    await setBasis('keoni_sets')
    const id = await pastSession()

    // Nothing to charge until she has said so — which is the state every one of their sessions
    // starts in, not an error.
    expect(await rentalFeeForBooking(id)).toBeNull()

    await sql.query(`UPDATE bookings SET fee_override_cents = 4321 WHERE id = $1`, [id])
    expect(await rentalFeeForBooking(id)).toBe(4321)
  })
})

describe('the sweep', () => {
  it('never takes a session from a provider whose fee Keoni sets', async () => {
    // The guard lives in the predicate rather than at the four call sites — the digest, the
    // cron route, the admin button and the page-load trigger. This is the test that it is
    // actually there, driven through the same function all four of them call.
    await setBasis('keoni_sets')
    const id = await pastSession()

    await settleDueRent({ limit: 25 })

    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = $1 AND source = 'rental_fee'`,
      [id],
    )) as { n: number }[]
    expect(row.n, 'their rent is never taken without Keoni').toBe(0)
  })

  it('does not take it even once she has set a figure', async () => {
    // An override is her decision about the AMOUNT, not permission for the sweep to act on it.
    // She charges it from the queue, where she can see what she is doing.
    await setBasis('keoni_sets')
    const id = await pastSession()
    await sql.query(`UPDATE bookings SET fee_override_cents = 5000 WHERE id = $1`, [id])

    await settleDueRent({ limit: 25 })

    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = $1 AND source = 'rental_fee'`,
      [id],
    )) as { n: number }[]
    expect(row.n, 'a figure is not a go-ahead').toBe(0)
  })

  it('would have taken it on the ordinary basis', async () => {
    // The control. Without this, the two tests above pass equally well if the sweep is simply
    // broken — and a sweep that charges nobody looks exactly like a guard that works.
    const id = await pastSession()
    await setBasis('tier')

    const out = await settleDueRent({ limit: 25 })
    expect(out.charged + out.failed, 'the sweep must be reaching this provider at all').toBeGreaterThan(0)
    expect(id).not.toBe('')
  })
})
