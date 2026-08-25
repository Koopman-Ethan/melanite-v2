import { describe, expect, it } from 'vitest'

import {
  percentDiscountCents,
  splitClientPayment,
  splitHouse,
  splitFee,
  toCents,
  toMoney,
} from '@/lib/money'

// The money arithmetic. Exhaustive where it can be, because this is the code whose failures are
// invisible: a split that is a cent wrong produces two plausible numbers and no error.

describe('toCents', () => {
  it('parses the strings a numeric column returns', () => {
    expect(toCents('200.00')).toBe(20000)
    expect(toCents('0.01')).toBe(1)
    expect(toCents('1400.50')).toBe(140050)
  })

  it('survives values that binary floating point gets wrong', () => {
    // 20.05 * 100 is 2004.9999999999998. Truncating instead of rounding loses a cent.
    expect(toCents(20.05)).toBe(2005)
    expect(toCents('8.29')).toBe(829)
  })

  it('cannot rescue a number that was already wrong before it arrived', () => {
    // The double 1.005 is really 1.00499999999999989, so it rounds to 100 — and no amount of
    // care here can recover the 1.005 someone meant. This is the reason money columns are
    // `numeric` and come back as STRINGS: by the time a price is a JavaScript number, the
    // damage may already be done.
    expect(toCents(1.005)).toBe(100)
    // The same value as a string is exact.
    expect(toCents('1.005')).toBe(101)
  })

  it('refuses a value that is not money', () => {
    expect(() => toCents('abc')).toThrow()
  })
})

describe('toMoney', () => {
  it('formats cents as the database expects', () => {
    expect(toMoney(20000)).toBe('200.00')
    expect(toMoney(1)).toBe('0.01')
    expect(toMoney(0)).toBe('0.00')
  })

  it('refuses fractional cents rather than silently rounding them', () => {
    expect(() => toMoney(100.5)).toThrow()
  })
})

describe('splitClientPayment', () => {
  it('splits a plain 50/50 booking', () => {
    expect(splitClientPayment({ grossCents: 20000, tipCents: 0, providerSharePct: 0.5 })).toEqual({
      providerPayoutCents: 10000,
      melaniteCutCents: 10000,
    })
  })

  it('gives the whole tip to the provider', () => {
    // Melanite takes no cut of a tip. $200 service + $40 tip: the cut is still $100.
    expect(splitClientPayment({ grossCents: 20000, tipCents: 4000, providerSharePct: 0.5 })).toEqual(
      { providerPayoutCents: 14000, melaniteCutCents: 10000 },
    )
  })

  it('honours a share other than half', () => {
    expect(splitClientPayment({ grossCents: 10000, tipCents: 0, providerSharePct: 0.7 })).toEqual({
      providerPayoutCents: 7000,
      melaniteCutCents: 3000,
    })
  })

  it('handles the half-cent case that the old code got wrong', () => {
    // $125.01 at a 50% share. The float implementation had Stripe taking 6251 as the application
    // fee while the ledger recorded 6250 — a cent that never reconciles.
    const split = splitClientPayment({ grossCents: 12501, tipCents: 0, providerSharePct: 0.5 })

    expect(split.providerPayoutCents + split.melaniteCutCents).toBe(12501)
    expect(split.melaniteCutCents).toBe(6251)
    expect(split.providerPayoutCents).toBe(6250)
  })

  it('never loses or invents a cent, at any price', () => {
    // The property that matters. Every price from $0.01 to $1,000, every share from 0 to 1 in
    // steps of 5%, with and without a tip: the parts must sum to the whole.
    for (let gross = 1; gross <= 100_000; gross += 7) {
      for (let pct = 0; pct <= 100; pct += 5) {
        for (const tip of [0, 1, 4000]) {
          const split = splitClientPayment({
            grossCents: gross,
            tipCents: tip,
            providerSharePct: pct / 100,
          })

          expect(split.providerPayoutCents + split.melaniteCutCents).toBe(gross + tip)
          expect(Number.isInteger(split.providerPayoutCents)).toBe(true)
          expect(Number.isInteger(split.melaniteCutCents)).toBe(true)
          expect(split.melaniteCutCents).toBeGreaterThanOrEqual(0)
          expect(split.providerPayoutCents).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('gives everything to the provider at a 100% share', () => {
    expect(splitClientPayment({ grossCents: 20000, tipCents: 0, providerSharePct: 1 })).toEqual({
      providerPayoutCents: 20000,
      melaniteCutCents: 0,
    })
  })

  it('gives everything to Melanite at a 0% share', () => {
    expect(splitClientPayment({ grossCents: 20000, tipCents: 0, providerSharePct: 0 })).toEqual({
      providerPayoutCents: 0,
      melaniteCutCents: 20000,
    })
  })

  it('refuses a nonsense share rather than producing a nonsense split', () => {
    expect(() => splitClientPayment({ grossCents: 100, tipCents: 0, providerSharePct: 1.5 })).toThrow()
    expect(() => splitClientPayment({ grossCents: 100, tipCents: 0, providerSharePct: -1 })).toThrow()
  })

  it('refuses fractional cents', () => {
    expect(() =>
      splitClientPayment({ grossCents: 100.5, tipCents: 0, providerSharePct: 0.5 }),
    ).toThrow()
  })
})

describe('splitFee', () => {
  it('splits a fee evenly', () => {
    expect(splitFee({ amountCents: 5000, providerSharePct: 0.5 })).toEqual({
      providerPayoutCents: 2500,
      melaniteCutCents: 2500,
    })
  })

  it('splits an odd amount without losing the odd cent', () => {
    const split = splitFee({ amountCents: 5001, providerSharePct: 0.5 })
    expect(split.providerPayoutCents + split.melaniteCutCents).toBe(5001)
  })

  it('never loses a cent at any amount or share', () => {
    for (let amount = 1; amount <= 50_000; amount += 13) {
      for (let pct = 0; pct <= 100; pct += 10) {
        const split = splitFee({ amountCents: amount, providerSharePct: pct / 100 })
        expect(split.providerPayoutCents + split.melaniteCutCents).toBe(amount)
      }
    }
  })
})

describe('percentDiscountCents', () => {
  it('takes a round percentage off', () => {
    expect(percentDiscountCents(20000, 10)).toBe(2000)
    expect(percentDiscountCents(20000, 25)).toBe(5000)
  })

  it('rounds a half cent up rather than dropping it', () => {
    // $2.01 at 50% is 100.5 cents. The float route lost that half.
    expect(percentDiscountCents(201, 50)).toBe(101)
  })

  it('is zero at zero percent and everything at a hundred', () => {
    expect(percentDiscountCents(12345, 0)).toBe(0)
    expect(percentDiscountCents(12345, 100)).toBe(12345)
  })
})

describe('splitHouse', () => {
  it('gives Melanite the service and the tip', () => {
    const split = splitHouse({ grossCents: 18000, tipCents: 2500 })

    expect(split.providerPayoutCents).toBe(0)
    expect(split.melaniteCutCents).toBe(20500)
  })

  it('still sums to what the client paid', () => {
    // The invariant every split in this file holds, and the database does not enforce.
    for (const [gross, tip] of [[0, 0], [1, 0], [18000, 2500], [12345, 6789]]) {
      const s = splitHouse({ grossCents: gross, tipCents: tip })
      expect(s.providerPayoutCents + s.melaniteCutCents).toBe(gross + tip)
    }
  })

  it('is NOT the same as a zero share, which is the whole reason it exists', () => {
    // `splitClientPayment` excludes the tip from the fee base by design — 100% of a tip reaches
    // the provider, which is v1's rule and the one providers were told. At a share of zero that
    // rule still fires, so the "obvious" way to express a house payment routes every tip away
    // from Melanite while looking perfectly correct.
    const gross = 18000
    const tip = 2500

    const asZeroShare = splitClientPayment({ grossCents: gross, tipCents: tip, providerSharePct: 0 })
    const asHouse = splitHouse({ grossCents: gross, tipCents: tip })

    expect(asZeroShare.providerPayoutCents).toBe(tip)
    expect(asHouse.providerPayoutCents).toBe(0)
    expect(asHouse.melaniteCutCents - asZeroShare.melaniteCutCents).toBe(tip)
  })

  it('agrees with a zero share when there is no tip', () => {
    // Which is exactly why the difference above is easy to miss: untipped, the two are
    // identical, so a test written without a tip would have proved nothing.
    const untipped = { grossCents: 18000, tipCents: 0 }
    expect(splitHouse(untipped)).toEqual(
      splitClientPayment({ ...untipped, providerSharePct: 0 }),
    )
  })

  it('refuses fractional cents, like every other split here', () => {
    expect(() => splitHouse({ grossCents: 100.5, tipCents: 0 })).toThrow()
    expect(() => splitHouse({ grossCents: 100, tipCents: -1 })).toThrow()
  })
})
