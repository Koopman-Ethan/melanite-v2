import { describe, expect, it } from 'vitest'

import {
  RENTAL_TIERS,
  SERVICE_TIER,
  UNPRICED,
  packFeeFor,
  packsFor,
  rentalFeeFor,
  tierForService,
} from '@/lib/rental-fees'

// What Melanite bills a provider for a session.
//
// Pure logic, no database. The valuable tests here are the frozen ones: these numbers are what a
// provider has agreed to pay, and a fee that changes because somebody tidied a table is a fee
// nobody agreed to. The service names are the catalogue's stable key, so a rename is a fee change
// and has to break something.

/** Every fee in Keoni's guide, written out by hand ON PURPOSE.
 *
 *  Deriving these from the module would make the test pass for any set of numbers, which is the
 *  one thing it must not do. If this fails, check the guide before touching the expectation. */
const FROZEN_SINGLES: Record<string, number> = {
  lhr_xs: 4000,
  lhr_small: 6000,
  lhr_medium: 9000,
  lhr_large: 13000,
  tattoo_xxs: 5000,
  tattoo_xs: 8700,
  tattoo_small: 11200,
  tattoo_medium: 15000,
  tattoo_large: 20000,
  clearlift_face: 18500,
  clearlift_lip: 7000,
}

const FROZEN_PACKS: Record<string, Record<number, number>> = {
  lhr_xs: { 6: 18500, 8: 26500 },
  lhr_small: { 6: 24500, 8: 29500 },
  lhr_medium: { 6: 39500, 8: 45000 },
  lhr_large: { 6: 62500, 8: 77500 },
  tattoo_xxs: { 8: 32500 },
  tattoo_xs: { 8: 57500 },
  tattoo_small: { 8: 72500 },
  tattoo_medium: { 8: 100000 },
  tattoo_large: { 8: 130000 },
  clearlift_face: { 3: 50000, 6: 90000 },
  clearlift_lip: {},
}

describe('the fee schedule, frozen', () => {
  it('charges what the guide says for one session', () => {
    const actual = Object.fromEntries(RENTAL_TIERS.map((t) => [t.key, t.fee.singleCents]))
    expect(actual).toEqual(FROZEN_SINGLES)
  })

  it('charges what the guide says for a pack', () => {
    const actual = Object.fromEntries(
      RENTAL_TIERS.map((t) => [
        t.key,
        Object.fromEntries(t.fee.packs.map((p) => [p.sessions, p.cents])),
      ]),
    )
    expect(actual).toEqual(FROZEN_PACKS)
  })

  it('never prices a pack at or above buying the sessions singly', () => {
    // A pack exists to be cheaper. One priced the wrong way round would be a data-entry slip that
    // no other test would catch, and a provider would find it before we did.
    for (const tier of RENTAL_TIERS) {
      for (const pack of tier.fee.packs) {
        expect(
          pack.cents,
          `${tier.key} ${pack.sessions}-pack costs more than ${pack.sessions} singles`,
        ).toBeLessThan(tier.fee.singleCents * pack.sessions)
      }
    }
  })

  it('has no duplicate tier keys', () => {
    const keys = RENTAL_TIERS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('maps every service to a tier that exists', () => {
    const keys = new Set(RENTAL_TIERS.map((t) => t.key))
    for (const [service, key] of Object.entries(SERVICE_TIER)) {
      expect(keys.has(key), `${service} points at unknown tier ${key}`).toBe(true)
    }
  })
})

describe('the service mapping, frozen', () => {
  it('puts the hair removal areas in the brackets the guide describes', () => {
    // The guide gives examples per bracket rather than a list of our service names, so this is the
    // reading of it. Frozen because re-reading it differently later would silently reprice a
    // provider's work.
    expect(SERVICE_TIER['Laser Hair Removal — Upper Lip']).toBe('lhr_xs')
    expect(SERVICE_TIER['Laser Hair Removal — Chin']).toBe('lhr_xs')
    expect(SERVICE_TIER['Laser Hair Removal — Underarms']).toBe('lhr_small')
    expect(SERVICE_TIER['Laser Hair Removal — Bikini']).toBe('lhr_small')
    expect(SERVICE_TIER['Laser Hair Removal — Brazilian']).toBe('lhr_medium')
    expect(SERVICE_TIER['Laser Hair Removal — Full Legs']).toBe('lhr_large')
  })

  it('reads abs as Medium and chest as Large', () => {
    // The guide lists "abs" under Medium and "chest/abs" under Large, so abs appears twice. This
    // is the judgement call; it is pinned so it gets re-made deliberately rather than drifting.
    expect(SERVICE_TIER['Laser Hair Removal — Abs']).toBe('lhr_medium')
    expect(SERVICE_TIER['Laser Hair Removal — Chest']).toBe('lhr_large')
  })

  it('maps the five tattoo sizes one to one', () => {
    expect(rentalFeeFor('Tattoo Removal (XXSmall)')).toBe(5000)
    expect(rentalFeeFor('Tattoo Removal (XSmall)')).toBe(8700)
    expect(rentalFeeFor('Tattoo Removal (Small)')).toBe(11200)
    expect(rentalFeeFor('Tattoo Removal (Medium)')).toBe(15000)
    expect(rentalFeeFor('Tattoo Removal (Large)')).toBe(20000)
  })
})

describe('services the guide does not price', () => {
  it('returns null rather than zero', () => {
    // The distinction this whole module turns on. A null is "cannot be booked yet" and the booking
    // path must refuse; a zero would be a free session nobody notices until the month's takings
    // are short.
    for (const service of Object.keys(UNPRICED)) {
      expect(rentalFeeFor(service), `${service} should have no fee`).toBeNull()
      expect(tierForService(service)).toBeNull()
    }
  })

  it('explains what is missing for each one', () => {
    // An unpriced service with no reason attached is a question nobody can answer later.
    for (const [service, why] of Object.entries(UNPRICED)) {
      expect(why.length, `${service} has no explanation`).toBeGreaterThan(30)
    }
  })

  it('never lists a service as both priced and unpriced', () => {
    for (const service of Object.keys(UNPRICED)) {
      expect(SERVICE_TIER[service], `${service} is in both tables`).toBeUndefined()
    }
  })

  it('returns null for a service that does not exist at all', () => {
    expect(rentalFeeFor('Massage')).toBeNull()
    expect(packFeeFor('Massage', 6)).toBeNull()
    expect(packsFor('Massage')).toEqual([])
  })
})

describe('pack lookups', () => {
  it('finds a published pack', () => {
    expect(packFeeFor('Laser Hair Removal — Brazilian', 6)).toBe(39500)
    expect(packFeeFor('Tattoo Removal (Medium)', 8)).toBe(100000)
    expect(packFeeFor('ClearLift', 3)).toBe(50000)
  })

  it('returns null for a pack size that tier does not publish', () => {
    // Hair removal has 6 and 8, not 3. Falling back to a nearby size would invent a price.
    expect(packFeeFor('Laser Hair Removal — Brazilian', 3)).toBeNull()
    expect(packFeeFor('ClearLift Lip Plumper', 3)).toBeNull()
  })

  it('lists the sizes a service can be pre-bought in', () => {
    expect(packsFor('Laser Hair Removal — Upper Lip').map((p) => p.sessions)).toEqual([6, 8])
    expect(packsFor('ClearLift').map((p) => p.sessions)).toEqual([3, 6])
    expect(packsFor('ClearLift Lip Plumper')).toEqual([])
  })
})
