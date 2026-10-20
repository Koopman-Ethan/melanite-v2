import { describe, expect, it } from 'vitest'

import { grossUpForProcessing } from '@/lib/money'
import {
  covers,
  denverYmd,
  describePromotion,
  discountedCents,
  overlaps,
  promotionFor,
  type DraftPromotion,
  type Promotion,
} from '@/lib/promotions'
import { validatePromotion, validatePricesAgainstPromotions } from '@/lib/validate/promotion'

// A temporary reduction on the rental fee, and the one bug it exists to not have.
//
// THE BUG: rent is charged about twelve hours after a session ends, so a Friday evening session
// is swept on Saturday morning. Asking "is a promotion running NOW" at charge time would bill
// full price for every session on a promotion's last day — the provider was quoted the
// promotional figure, worked at it, and would then be charged something else. Every function
// here takes the session's date for that reason, and the test below pins it.
//
// Pure. No database: the resolution is arithmetic over rows, and the rows are the easy part.

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: 'p1',
  name: 'October promotion',
  tierKey: null,
  kind: 'percent',
  value: 25,
  startsOn: '2026-10-21',
  endsOn: '2026-10-31',
  endedAt: null,
  ...over,
})

const TIERS = [
  { tierKey: 'lhr_xs', label: 'Hair removal — XS', singleCents: 3500 },
  { tierKey: 'lhr_small', label: 'Hair removal — Small', singleCents: 6000 },
  { tierKey: 'lhr_medium', label: 'Hair removal — Medium', singleCents: 9500 },
]

const draft = (over: Partial<DraftPromotion> = {}): DraftPromotion => ({
  name: 'October promotion',
  tierKey: null,
  kind: 'percent',
  value: 25,
  startsOn: '2026-10-21',
  endsOn: '2026-10-31',
  ...over,
})

describe('what a promotion takes off', () => {
  it('takes a percentage off the listed fee', () => {
    expect(discountedCents(6000, promo({ kind: 'percent', value: 25 }))).toBe(4500)
  })

  it('takes a flat amount off the listed fee', () => {
    expect(discountedCents(6000, promo({ kind: 'amount', value: 1500 }))).toBe(4500)
  })

  it('leaves the fee alone when nothing applies', () => {
    expect(discountedCents(6000, null)).toBe(6000)
  })

  it('never returns a negative fee', () => {
    // Creation refuses this, but a promotion outliving a repricing of the schedule could reach
    // it — and a negative fee would be a REFUND dressed as rent.
    expect(discountedCents(1000, promo({ kind: 'amount', value: 5000 }))).toBe(0)
  })

  it('rounds a percentage to whole cents', () => {
    // 33% of $35 is $11.55 exactly; 33% of $95 is $31.35. A fractional cent reaching the
    // ledger is where the penny disagreements in this codebase have always started.
    for (const tier of TIERS) {
      const out = discountedCents(tier.singleCents, promo({ value: 33 }))
      expect(Number.isInteger(out), `${tier.tierKey} produced ${out}`).toBe(true)
    }
  })
})

describe('which promotion applies, and when', () => {
  it('covers only its own tier when it names one', () => {
    const one = promo({ tierKey: 'lhr_small' })
    expect(covers(one, 'lhr_small')).toBe(true)
    expect(covers(one, 'lhr_medium')).toBe(false)
  })

  it('covers every tier when it names none', () => {
    expect(covers(promo({ tierKey: null }), 'anything_at_all')).toBe(true)
  })

  it('applies on the first and last day, both included', () => {
    const all = [promo()]
    expect(promotionFor('lhr_small', '2026-10-21', all)).not.toBeNull()
    expect(promotionFor('lhr_small', '2026-10-31', all)).not.toBeNull()
  })

  it('does not apply the day before it starts or the day after it ends', () => {
    const all = [promo()]
    expect(promotionFor('lhr_small', '2026-10-20', all)).toBeNull()
    expect(promotionFor('lhr_small', '2026-11-01', all)).toBeNull()
  })

  it('still applies to a session on the last day that is CHARGED the next morning', () => {
    // THE WHOLE POINT. The sweep runs on 1 November for a session that happened on 31 October.
    // Resolving against the sweep's date charges full price; resolving against the session's
    // date charges what the provider was quoted.
    const all = [promo()]
    const sessionDay = '2026-10-31'
    const sweepDay = '2026-11-01'

    expect(promotionFor('lhr_small', sessionDay, all), 'the session was inside the promotion')
      .not.toBeNull()
    expect(promotionFor('lhr_small', sweepDay, all), 'the sweep is outside it').toBeNull()

    // And the fee that gets charged follows the session, not the sweep.
    expect(discountedCents(6000, promotionFor('lhr_small', sessionDay, all))).toBe(4500)
  })

  it('reads the date in Denver, not UTC', () => {
    // 31 October, 7pm Denver is already 1 November in UTC. An evening session on a promotion's
    // last day must not fall out of it because of the timezone the server happens to be in.
    const evening = new Date('2026-11-01T01:00:00Z')
    expect(denverYmd(evening)).toBe('2026-10-31')
    expect(promotionFor('lhr_small', denverYmd(evening), [promo()])).not.toBeNull()
  })
})

describe('two promotions at once', () => {
  it('sees an overlap on the same tier', () => {
    const a = promo({ tierKey: 'lhr_small', startsOn: '2026-10-21', endsOn: '2026-10-31' })
    const b = promo({ tierKey: 'lhr_small', startsOn: '2026-10-30', endsOn: '2026-11-05' })
    expect(overlaps(a, b)).toBe(true)
  })

  it('sees no overlap on different tiers', () => {
    const a = promo({ tierKey: 'lhr_small' })
    const b = promo({ tierKey: 'lhr_medium' })
    expect(overlaps(a, b)).toBe(false)
  })

  it('treats an every-service promotion as overlapping a single-tier one', () => {
    const everything = promo({ tierKey: null })
    const one = promo({ tierKey: 'lhr_small' })
    expect(overlaps(everything, one)).toBe(true)
    expect(overlaps(one, everything), 'and in the other direction').toBe(true)
  })

  it('sees no overlap when the windows do not touch', () => {
    const a = promo({ startsOn: '2026-10-01', endsOn: '2026-10-15' })
    const b = promo({ startsOn: '2026-10-16', endsOn: '2026-10-31' })
    expect(overlaps(a, b)).toBe(false)
  })
})

describe('what Keoni is allowed to create', () => {
  const context = { today: '2026-10-20', tiers: TIERS, existing: [] as Promotion[] }

  it('accepts an ordinary promotion', () => {
    expect(validatePromotion(draft(), context)).toBeNull()
  })

  it('refuses one with no name, because the provider sees it', () => {
    expect(validatePromotion(draft({ name: '  ' }), context)).toMatch(/name/i)
  })

  it('refuses one that ends before it starts', () => {
    expect(
      validatePromotion(draft({ startsOn: '2026-10-31', endsOn: '2026-10-21' }), context),
    ).toMatch(/ends before/i)
  })

  it('refuses one starting in the past', () => {
    // Sessions on those days may already have been charged, and a promotion cannot reach back
    // and change what they should have cost.
    expect(validatePromotion(draft({ startsOn: '2026-10-19' }), context)).toMatch(/past/i)
  })

  it('refuses a reduction that would leave nothing chargeable', () => {
    // A near-zero fee is a FAILED CHARGE, not a gift: Stripe refuses anything under 50c once
    // processing is added, so this would surface as a decline on somebody's session.
    const message = validatePromotion(draft({ kind: 'amount', value: 3500 }), context)
    expect(message).toMatch(/too small to put on a card/)
    expect(message, 'and points at the thing that does make a session free').toMatch(
      /Don’t charge it/,
    )
  })

  it('refuses a reduction leaving a fee too small for Stripe, even above zero', () => {
    // $34.50 off the $35 tier leaves 50c, which grosses up to 83c — chargeable, but absurd —
    // and 10c would gross up to 42c and be REFUSED by Stripe. The floor is a dollar so the
    // rule is one a person can hold in their head.
    expect(validatePromotion(draft({ kind: 'amount', value: 3450 }), context)).toMatch(
      /too small to put on a card/,
    )
  })

  it('refuses 100% off for the same reason', () => {
    expect(validatePromotion(draft({ kind: 'percent', value: 100 }), context)).toMatch(/99%/)
  })

  it('judges a flat amount against the cheapest tier it actually covers', () => {
    // $35 off every service would zero the $35 tier, so it is refused — but the same $35 off
    // the $60 tier alone leaves $25 and is fine. What a promotion covers decides whether the
    // same figure is allowed.
    expect(validatePromotion(draft({ kind: 'amount', value: 3500 }), context)).toMatch(
      /too small/,
    )
    expect(
      validatePromotion(draft({ kind: 'amount', value: 3500, tierKey: 'lhr_small' }), context),
    ).toBeNull()
  })

  it('refuses one overlapping an existing promotion, and names it', () => {
    const existing = [promo({ name: 'Autumn offer', tierKey: 'lhr_small' })]
    const message = validatePromotion(draft({ tierKey: 'lhr_small' }), { ...context, existing })
    expect(message).toMatch(/Autumn offer/)
    expect(message, 'and says how to get out of it').toMatch(/End that one first/)
  })

  it('refuses a single-tier promotion clashing with an every-service one', () => {
    const existing = [promo({ name: 'November sale', tierKey: null })]
    expect(
      validatePromotion(draft({ tierKey: 'lhr_medium' }), { ...context, existing }),
    ).toMatch(/November sale/)
  })

  it('allows a second promotion on a different tier', () => {
    const existing = [promo({ name: 'Autumn offer', tierKey: 'lhr_small' })]
    expect(
      validatePromotion(draft({ tierKey: 'lhr_medium' }), { ...context, existing }),
    ).toBeNull()
  })

  it('allows a promotion after an existing one has finished', () => {
    const existing = [promo({ startsOn: '2026-10-21', endsOn: '2026-10-25' })]
    expect(
      validatePromotion(draft({ startsOn: '2026-10-26', endsOn: '2026-10-31' }), {
        ...context,
        existing,
      }),
    ).toBeNull()
  })
})

describe('ending a promotion early', () => {
  // THE PROMISE. "End it now" stops the promotion being handed to anybody else; it does not
  // reach forward and reprice work already agreed to. A provider who booked next Tuesday at
  // $85.50 is charged $85.50, whatever Keoni does on Monday.
  const endedOn25th = promo({ endedAt: new Date('2026-10-25T18:00:00Z') })

  const bookedBefore = new Date('2026-10-22T16:00:00Z')
  const bookedAfter = new Date('2026-10-27T16:00:00Z')

  it('keeps its price for a session booked before it was ended', () => {
    const got = promotionFor('lhr_small', '2026-10-28', [endedOn25th], bookedBefore)
    expect(got, 'booked on the 22nd, ended on the 25th, session on the 28th').not.toBeNull()
    expect(discountedCents(6000, got)).toBe(4500)
  })

  it('does not apply to a booking made after it was ended', () => {
    expect(promotionFor('lhr_small', '2026-10-28', [endedOn25th], bookedAfter)).toBeNull()
  })

  it('is gone from a fresh quote, which is what ending it is for', () => {
    // No `bookedAt` means "being promised right now". Relative to the clock rather than to a
    // fixed date, because `endedAt` is stamped when the button is pressed — a hardcoded one
    // would be in the suite's future today and its past next year, and the test would read as
    // flaky when the only moving part was the calendar.
    const justEnded = promo({ endedAt: new Date(Date.now() - 1000) })
    expect(promotionFor('lhr_small', '2026-10-28', [justEnded])).toBeNull()
  })

  it('still stops at its own last day for a booking made before it ended', () => {
    // Ending early cannot EXTEND it. The advertised window is still the outer limit.
    expect(promotionFor('lhr_small', '2026-11-01', [endedOn25th], bookedBefore)).toBeNull()
  })

  it('hands a session to whichever promotion was in force when it was booked', () => {
    // End one on the 25th, start another on the 26th, and the days they share belong to the
    // one that was running when the booking was taken.
    const replacement = promo({
      id: 'p2',
      name: 'Late October',
      value: 10,
      startsOn: '2026-10-26',
      endsOn: '2026-10-31',
    })
    const all = [endedOn25th, replacement]

    expect(promotionFor('lhr_small', '2026-10-28', all, bookedBefore)?.name).toBe(
      'October promotion',
    )
    expect(promotionFor('lhr_small', '2026-10-28', all, bookedAfter)?.name).toBe('Late October')
  })
})

describe('republishing prices under a running promotion', () => {
  // The floor, kept from the other side. Creating a promotion refuses one that would take a fee
  // under a dollar — which leaves the same floor walkable by repricing a tier low enough that a
  // promotion already on the books reduces it below what Stripe will accept.
  const thirtyOff = [promo({ kind: 'amount', value: 3000 })]

  it('allows prices that stay above the floor', () => {
    expect(validatePricesAgainstPromotions(TIERS, thirtyOff)).toBeNull()
  })

  it('refuses a price that a running promotion would reduce below a dollar', () => {
    const lowered = [{ tierKey: 'lhr_xs', label: 'Hair removal — XS', singleCents: 3010 }]
    const message = validatePricesAgainstPromotions(lowered, thirtyOff)
    expect(message).toMatch(/too small to put on a card/)
    expect(message, 'and names the promotion in the way').toMatch(/October promotion/)
  })

  it('ignores a promotion that does not cover the tier being lowered', () => {
    const elsewhere = [promo({ kind: 'amount', value: 3000, tierKey: 'lhr_medium' })]
    const lowered = [{ tierKey: 'lhr_xs', label: 'Hair removal — XS', singleCents: 3010 }]
    expect(validatePricesAgainstPromotions(lowered, elsewhere)).toBeNull()
  })

  it('refuses a price a percentage promotion would reduce below a dollar', () => {
    const ninetyNine = [promo({ kind: 'percent', value: 99 })]
    const lowered = [{ tierKey: 'lhr_xs', label: 'Hair removal — XS', singleCents: 5000 }]
    expect(validatePricesAgainstPromotions(lowered, ninetyNine)).toMatch(/too small/)
  })
})

describe('the promotion and the processing gross-up', () => {
  it('discounts what Melanite keeps, not what Stripe takes', () => {
    // ORDER MATTERS. The schedule is the NET Melanite nets, and processing is added on top.
    // Discounting the grossed-up figure would quietly discount Melanite's processing recovery
    // too, so it would net less than the promotional price it set.
    const listed = 6000
    const net = discountedCents(listed, promo({ value: 25 }))
    expect(net).toBe(4500)

    const { chargeCents, netCents } = grossUpForProcessing({
      netCents: net,
      pct: 0.029,
      fixedCents: 30,
    })

    expect(chargeCents, 'the card takes more than the promotional fee').toBeGreaterThan(net)
    expect(netCents, 'and Melanite still nets the promotional fee').toBeGreaterThanOrEqual(net)
  })
})

describe('how a promotion reads', () => {
  it('describes a percentage and an amount the way a person would say them', () => {
    expect(describePromotion(promo({ kind: 'percent', value: 25 }))).toBe('25% off')
    expect(describePromotion(promo({ kind: 'amount', value: 1500 }))).toBe('$15.00 off')
  })
})
