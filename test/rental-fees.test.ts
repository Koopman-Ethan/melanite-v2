import { describe, expect, it } from 'vitest'

import {
  RENTAL_TIERS,
  SERVICE_TIER,
  UNPRICED,
  seedFeeFor,
  tierByKey,
  tierForService,
} from '@/lib/rental-fees'

// What Melanite bills a provider for a session.
//
// Pure logic, no database. These numbers are the SEED — the schedule the code ships with and
// what a tier falls back to until a published version prices it. What is actually charged lives
// in `rental_fee_schedules` and is tested in `test/rental-schedule.test.ts`.
//
// Still frozen, and still worth freezing. The seed is what a brand-new environment starts from
// and what the cutover publishes as v1, so a number changing here because somebody tidied a
// table would quietly change what the next environment charges. The service names are the
// catalogue's stable key, so a rename is a fee change and has to break something.

/** Every fee in Keoni's guide, written out by hand ON PURPOSE.
 *
 *  Deriving these from the module would make the test pass for any set of numbers, which is the
 *  one thing it must not do. If this fails, check the guide before touching the expectation.
 *
 *  Revised 3 October 2026 — the second schedule. XS hair removal came down from $40 to $35,
 *  medium went $90 to $95, large $130 to $120, and the tattoo sizes lost their odd cents. The
 *  four services that had no fee at all now have one. */
const FROZEN_SINGLES: Record<string, number> = {
  lhr_xs: 3500,
  lhr_small: 6000,
  lhr_medium: 9500,
  lhr_large: 12000,

  tattoo_xxs: 5000,
  tattoo_xs: 8500,
  tattoo_small: 11000,
  tattoo_medium: 15000,
  tattoo_large: 20000,

  ipl_face: 15000,
  ipl_neck: 10000,
  ipl_chest: 13500,
  ipl_hands: 7500,
  vascupen: 4500,

  clearlift_face: 17500,
  clearlift_neck: 9500,
  clearlift_hands: 8500,
  clearlift_lip: 7000,
  sunspots: 4500,
}

describe('the fee schedule, frozen', () => {
  it('charges what the guide says for one session', () => {
    const actual = Object.fromEntries(RENTAL_TIERS.map((t) => [t.key, t.singleCents]))
    expect(actual).toEqual(FROZEN_SINGLES)
  })

  it('sells no packs', () => {
    // Keoni withdrew pack rates on 3 October — packages are the provider's business. A pack
    // rate reappearing here would put Melanite back in the middle of a pricing decision, so it
    // has to be a deliberate change rather than a quiet one.
    for (const tier of RENTAL_TIERS) {
      expect(Object.keys(tier)).not.toContain('packs')
    }
  })

  it('keeps every fee below the price the guide suggests charging', () => {
    // The whole model: the fee is roughly half of market, and what the provider charges above
    // it is theirs. A fee at or above the suggested price would mean renting at a loss, which
    // is the kind of data-entry slip a provider finds before we do.
    for (const tier of RENTAL_TIERS) {
      expect(tier.singleCents, `${tier.key} costs more to rent than the guide says to charge`)
        .toBeLessThan(tier.suggestedLowCents)
    }
  })

  it('states a suggested range the right way round', () => {
    for (const tier of RENTAL_TIERS) {
      expect(tier.suggestedHighCents, `${tier.key} has a backwards range`)
        .toBeGreaterThanOrEqual(tier.suggestedLowCents)
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

  it('has no tier nothing maps to', () => {
    // A tier with no service is a fee that can never be charged — either a service is missing
    // from the catalogue or the tier is left over from a schedule nobody uses.
    const used = new Set(Object.values(SERVICE_TIER))
    const orphaned = RENTAL_TIERS.filter((t) => !used.has(t.key)).map((t) => t.key)
    expect(orphaned).toEqual([])
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
    expect(seedFeeFor('Tattoo Removal (XXSmall)')).toBe(5000)
    expect(seedFeeFor('Tattoo Removal (XSmall)')).toBe(8500)
    expect(seedFeeFor('Tattoo Removal (Small)')).toBe(11000)
    expect(seedFeeFor('Tattoo Removal (Medium)')).toBe(15000)
    expect(seedFeeFor('Tattoo Removal (Large)')).toBe(20000)
  })

  it('prices each IPL area separately', () => {
    // The reason the catalogue was split. One generic IPL at one price was the thing Keoni
    // specifically asked not to have: "people charge different prices for each area".
    expect(seedFeeFor('IPL — Full Face')).toBe(15000)
    expect(seedFeeFor('IPL — Neck')).toBe(10000)
    expect(seedFeeFor('IPL — Chest')).toBe(13500)
    expect(seedFeeFor('IPL — Hands')).toBe(7500)
  })

  it('prices each ClearLift area separately', () => {
    expect(seedFeeFor('ClearLift')).toBe(17500)
    expect(seedFeeFor('ClearLift — Neck')).toBe(9500)
    expect(seedFeeFor('ClearLift — Hands')).toBe(8500)
    expect(seedFeeFor('ClearLift Lip Plumper')).toBe(7000)
  })

  it('charges the same for carbon as for ClearLift', () => {
    // Keoni, 3 October: "the carbon laser treatment can be the same price as the clearlift
    // treatment". The same TIER rather than the same number typed twice, so the two cannot
    // drift apart when one of them is repriced.
    expect(SERVICE_TIER['Carbon Laser Treatment']).toBe(SERVICE_TIER['ClearLift'])
    expect(seedFeeFor('Carbon Laser Treatment')).toBe(seedFeeFor('ClearLift'))
  })

  it('prices the two that were guesses until Keoni confirmed them', () => {
    // Facial vein removal was "possibly the guide's 20 min VascuPen, but that is an inference".
    // Sunspots were not in the guide at all. Both were listed as UNPRICED and refused at the
    // booking form until 3 October.
    expect(seedFeeFor('Facial Vein Removal')).toBe(4500)
    expect(seedFeeFor('Sunspot Removal')).toBe(4500)
  })
})

describe('services the guide does not price', () => {
  it('has none left', () => {
    // Empty since 3 October. The mechanism stays — see the note on UNPRICED — but every
    // bookable service now has a fee, which is what unblocked the four that could not be
    // booked at all.
    expect(UNPRICED).toEqual({})
  })

  it('never lists a service as both priced and unpriced', () => {
    for (const service of Object.keys(UNPRICED)) {
      expect(SERVICE_TIER[service], `${service} is in both tables`).toBeUndefined()
    }
  })

  it('returns null for a service that does not exist at all', () => {
    // The distinction the whole module turns on. A null is "cannot be booked" and the booking
    // path must refuse; a zero would be a free session nobody notices until the month's takings
    // are short.
    expect(seedFeeFor('Massage')).toBeNull()
    expect(tierForService('Massage')).toBeNull()
  })

  it('returns null for the retired generic IPL', () => {
    // Replaced by the four areas and retired from the catalogue. If it somehow came back as a
    // bookable service it must refuse rather than pick an area's price.
    expect(seedFeeFor('IPL')).toBeNull()
  })
})

describe('tier lookup by key', () => {
  it('finds a tier that exists', () => {
    expect(tierByKey('lhr_small')?.singleCents).toBe(6000)
  })

  it('returns null for one that does not', () => {
    expect(tierByKey('lhr_enormous')).toBeNull()
  })
})
