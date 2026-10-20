import { covers, describePromotion, discountedCents, overlaps, type Promotion } from '@/lib/promotions'

// Promotion rules. Out here for the same reason as the training course: a `'use server'` module
// may only export async functions.
//
// Every rule that decides whether a promotion may exist lives here, so the admin form and the
// action check exactly the same things and cannot disagree about what is allowed. The form can
// then say no before the round trip, and the action still says no if somebody posts past it.

export const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The smallest fee a promotion may leave behind.
 *
 *  NOT ZERO, which is the obvious floor and the wrong one. Stripe refuses a charge under 50c,
 *  and the fee is grossed up for processing before it gets there — so a fee of 10c becomes a
 *  42c charge and fails, surfacing as a card decline on a provider who did nothing wrong. A
 *  dollar is comfortably clear of that and is a figure a person can reason about, which "19
 *  cents, because of how the gross-up rounds" is not. */
const MIN_FEE_CENTS = 100

/** A tier as this module needs to see it: a key, a name to put in a sentence, and the fee a
 *  promotion would reduce. */
export interface PricedTier {
  tierKey: string
  label: string
  singleCents: number
}

/** The promotion being created, before it has an id. */
export type DraftPromotion = Omit<Promotion, 'id'>

export function validatePromotion(
  draft: DraftPromotion,
  context: {
    today: string
    /** Every tier with its CURRENT fee, so "would this make something free" is answerable. */
    tiers: readonly PricedTier[]
    /** Promotions already created and not yet finished — the overlap is checked against these. */
    existing: readonly Promotion[]
  },
): string | null {
  if (!draft.name.trim()) {
    // It appears on a provider's receipt, so it is a name rather than a note to self.
    return 'Give the promotion a name — providers see it on their receipt.'
  }
  if (draft.name.trim().length > 60) return 'That name is too long for a receipt line.'

  if (!DATE.test(draft.startsOn) || !DATE.test(draft.endsOn)) {
    return 'Pick a start and an end date.'
  }
  if (draft.endsOn < draft.startsOn) return 'The promotion ends before it starts.'
  // A promotion starting in the past would retroactively change what sessions already charged
  // should have cost, and some of them have already been charged.
  if (draft.startsOn < context.today) return 'A promotion cannot start in the past.'

  if (draft.kind === 'percent') {
    if (!Number.isInteger(draft.value) || draft.value < 1 || draft.value > 99) {
      // 100 is excluded by the same rule that excludes any reduction to zero, below — but
      // saying it here gives the better sentence.
      return 'Take between 1% and 99% off. For a free session, use “Don’t charge it” in the queue.'
    }
  } else {
    if (!Number.isInteger(draft.value) || draft.value < 1) return 'Set an amount to take off.'
    if (draft.value > 1_000_00) return 'That amount looks wrong — check the figure.'
  }

  const affected = context.tiers.filter((t) => covers({ ...draft, id: '' }, t.tierKey))
  if (affected.length === 0) return 'That service is not on the schedule.'

  // A FEE REDUCED TO ALMOST NOTHING IS A FAILED CHARGE, NOT A GIFT. Zero stays zero through
  // `grossUpForProcessing`, and anything under 50c is refused by Stripe once processing is
  // added — either way it surfaces as a decline on a provider who did nothing wrong, rather
  // than as a free session. Refused up front, pointing at the mechanism that DOES make a
  // session free.
  const tooSmall = affected
    .map((t) => ({ ...t, after: discountedCents(t.singleCents, { ...draft, id: '' }) }))
    .filter((t) => t.after < MIN_FEE_CENTS)

  if (tooSmall.length > 0) {
    const worst = tooSmall.reduce((a, b) => (a.after <= b.after ? a : b))
    const name = tooSmall.length === 1 ? worst.label : `${tooSmall.length} services`
    return (
      `${describePromotion({ ...draft, id: '' })} would leave ${name} at ` +
      `$${(worst.after / 100).toFixed(2)}, which is too small to put on a card. ` +
      'Use “Don’t charge it” in the queue for a session you want to give away.'
    )
  }

  // ONE PROMOTION PER SERVICE AT A TIME. Two running at once raises "which one applied" on
  // every charge, and the answer is not visible on the page. Refused by name so the way out is
  // obvious.
  const clash = context.existing.find((p) => overlaps(p, { ...draft, id: '' }))
  if (clash) {
    const where = clash.tierKey === null ? 'Everything' : labelFor(context.tiers, clash.tierKey)
    return (
      `${where} already has ${describePromotion(clash)} until ` +
      `${clash.endsOn} (“${clash.name}”). End that one first.`
    )
  }

  return null
}

function labelFor(tiers: readonly PricedTier[], tierKey: string): string {
  return tiers.find((t) => t.tierKey === tierKey)?.label ?? tierKey
}
