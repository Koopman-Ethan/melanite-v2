import { describe, expect, it } from 'vitest'

import { SERVICE_TIER, UNPRICED } from '@/lib/rental-fees'

// Does the fee schedule still describe the catalogue it is supposed to price?
//
// `rental-fees.test.ts` checks the numbers are what the guide says. This checks they are attached
// to services that actually exist — which is the failure the numbers alone cannot catch.
//
// Both directions matter, and they fail differently:
//
//   a service with no entry      a provider cannot book it, or worse, books it for nothing
//   an entry with no service     a rename happened and the fee silently stopped applying
//
// The second is the quiet one. Service names are the key, `catalogue.ts` matches on name too, and a
// tidy-up of "Laser Hair Removal — Upper Lip" would leave a fee pointing at nothing with every test
// still green. So this runs against the real catalogue rather than a copy of it.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

async function activeServiceNames(): Promise<string[]> {
  const rows = (await sql.query(
    `SELECT name FROM services WHERE active ORDER BY name`,
  )) as { name: string }[]
  return rows.map((r) => r.name)
}

describe('fee schedule coverage', () => {
  it('prices, or explicitly declines to price, every bookable service', async () => {
    const services = await activeServiceNames()
    expect(services.length, 'no active services — is this pointed at a real database?')
      .toBeGreaterThan(0)

    const unaccounted = services.filter((n) => !(n in SERVICE_TIER) && !(n in UNPRICED))

    expect(
      unaccounted,
      `these services have no rental fee and are not listed in UNPRICED:\n  ${unaccounted.join('\n  ')}\n` +
        'Add a tier in lib/rental-fees.ts, or add it to UNPRICED with the question it raises.',
    ).toEqual([])
  })

  it('has no fee pointing at a service that no longer exists', async () => {
    // A rename is a fee change. This is the assertion that makes that true rather than aspirational.
    const services = new Set(await activeServiceNames())
    const named = [...Object.keys(SERVICE_TIER), ...Object.keys(UNPRICED)]

    const orphaned = named.filter((n) => !services.has(n))

    expect(
      orphaned,
      `lib/rental-fees.ts names services that are not active in the catalogue:\n  ${orphaned.join('\n  ')}\n` +
        'Either the service was renamed — in which case update the fee schedule deliberately — or ' +
        'it was retired and its fee should go with it.',
    ).toEqual([])
  })

  it('leaves the retired size brackets alone', async () => {
    // Migration 0024 retired "Laser Hair Removal (Small)" and friends but kept the rows for FK
    // integrity. They are inactive, nobody can book them, and they must not acquire a fee — a fee
    // on a retired service is a bracket quietly coming back.
    const retired = (await sql.query(
      `SELECT name FROM services WHERE NOT active`,
    )) as { name: string }[]

    for (const { name } of retired) {
      expect(SERVICE_TIER[name], `${name} is retired but has a rental fee`).toBeUndefined()
    }
  })
})
