// Money arithmetic. One implementation, integer cents, no floats.
//
// This exists because there were three of them. `handlers.ts` computed the split in float
// dollars (`gross - gross * share`, then `.toFixed(2)`), `pay/actions.ts` computed the Stripe
// application fee in integer cents (`Math.round(cents * (1 - share))`), and `fees.ts` did
// something in between. Two of those disagree.
//
// They disagree wherever `price × share` lands on a half cent, because `Math.round` rounds half
// up while `toFixed` is at the mercy of the binary representation — 1.005 is really
// 1.00499999…, so it rounds DOWN. A $125.01 booking had Stripe taking $62.51 in application fee
// while the ledger recorded Melanite's cut as $62.50. Nothing fails; the books are just a cent
// out, and they stay a cent out forever.
//
// Two rules make that impossible here:
//
//   1. Everything is integer cents until the moment it is written or displayed.
//   2. ONE side of a split is rounded and the other is the remainder. The parts then sum to the
//      whole by construction, which is the invariant the ledger tests assert.

/** Parses a money value into integer cents.
 *
 *  A STRING is parsed by its decimal digits and never becomes a float — which matters, because
 *  `Number('1.005')` is 1.00499999999999989 and rounds to 100, losing the cent before any
 *  arithmetic happens. Since `numeric` columns come back as strings, that is the path almost
 *  every price in this app takes.
 *
 *  A NUMBER is rounded as well as it can be, but the damage may already be done: the double
 *  1.005 is not 1.005 and nothing here can recover it. Prefer strings.
 */
export function toCents(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a money value: ${String(value)}`)
    return Math.round(value * 100)
  }

  const match = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(value)
  if (!match) throw new Error(`Not a money value: ${value}`)

  const [, sign, whole, fraction = ''] = match
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2))
  // Round on the third decimal digit, half up — decimal rounding, not binary.
  const rounded = Number(fraction[2] ?? '0') >= 5 ? cents + 1 : cents

  return sign ? -rounded : rounded
}

/** Formats integer cents as the `numeric(10,2)` string the database expects. */
export function toMoney(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Not whole cents: ${cents}`)
  return (cents / 100).toFixed(2)
}

export interface Split {
  /** What the provider receives: their share of the service, plus the whole tip. */
  providerPayoutCents: number
  /** What Melanite keeps. Also the Stripe `application_fee_amount` for a destination charge. */
  melaniteCutCents: number
}

/**
 * Splits a client payment between the provider and Melanite.
 *
 * The TIP IS EXCLUDED from the fee base — 100% of a tip reaches the provider. That is v1's rule
 * and the one providers were told, so it is not a detail to re-derive per call site.
 *
 * Melanite's cut is the rounded side and the provider's payout is the remainder, so
 * `providerPayout + melaniteCut === gross + tip` exactly, for every input, with no rounding
 * residue to reconcile later.
 */
export function splitClientPayment(input: {
  grossCents: number
  tipCents: number
  providerSharePct: number
}): Split {
  assertWhole(input.grossCents, 'gross')
  assertWhole(input.tipCents, 'tip')
  assertShare(input.providerSharePct)

  const melaniteCutCents = Math.round(input.grossCents * (1 - input.providerSharePct))
  const providerPayoutCents = input.grossCents - melaniteCutCents + input.tipCents

  return { providerPayoutCents, melaniteCutCents }
}

/**
 * The house takes everything.
 *
 * For an appointment performed by Melanite itself there is no second party: no Connect
 * transfer, no payout, and the tip is Melanite's too.
 *
 * Deliberately NOT `splitClientPayment({ providerSharePct: 0 })`. That call is legal —
 * `assertShare` accepts zero — and it is wrong in a way nothing would catch: the tip is
 * excluded from the fee base by design, so a share of zero still routes 100% of every tip to
 * the provider side. A house payment is a different rule, not an extreme of the ordinary one,
 * and writing it as one is how a tip would quietly go missing from Melanite's revenue.
 */
export function splitHouse(input: { grossCents: number; tipCents: number }): Split {
  assertWhole(input.grossCents, 'gross')
  assertWhole(input.tipCents, 'tip')

  return {
    providerPayoutCents: 0,
    melaniteCutCents: input.grossCents + input.tipCents,
  }
}

/**
 * Splits a no-show or late-cancellation fee.
 *
 * Separate from the service split on purpose: a fee is not a service, and Melanite splits fees
 * evenly while the service share is configurable. Same rounding discipline — the provider's
 * share is rounded, Melanite takes the remainder, so the two always sum to the fee.
 */
export function splitFee(input: { amountCents: number; providerSharePct: number }): Split {
  assertWhole(input.amountCents, 'fee amount')
  assertShare(input.providerSharePct)

  const providerPayoutCents = Math.round(input.amountCents * input.providerSharePct)

  return {
    providerPayoutCents,
    melaniteCutCents: input.amountCents - providerPayoutCents,
  }
}

/** A percentage discount, in cents. */
export function percentDiscountCents(originalCents: number, percent: number): number {
  assertWhole(originalCents, 'original price')
  return Math.round(originalCents * (percent / 100))
}

function assertWhole(cents: number, what: string): void {
  if (!Number.isInteger(cents)) throw new Error(`${what} must be whole cents, got ${cents}`)
  if (cents < 0) throw new Error(`${what} cannot be negative, got ${cents}`)
}

function assertShare(pct: number): void {
  if (!(pct >= 0 && pct <= 1)) {
    throw new Error(`Share must be between 0 and 1, got ${pct}`)
  }
}

/** What Stripe takes, and what it leaves. */
export interface Processing {
  /** What the card is actually charged, in cents. */
  chargeCents: number
  /** What Stripe is expected to take out of it. An ESTIMATE — the real figure comes back on the
   *  balance transaction and is recorded then. */
  estimatedFeeCents: number
  /** What Melanite expects to be left with. The figure the fee schedule is written in. */
  netCents: number
}

/**
 * Grosses a fee up so Melanite nets what it meant to charge.
 *
 * WHY THIS IS NOT `net * 1.029 + 30`. The obvious version under-recovers, every time, because
 * Stripe's percentage applies to the LARGER amount once the surcharge is added. Charging
 * $60 + 2.9% + 30¢ = $62.04 means Stripe takes 2.9% of $62.04, not of $60 — so Melanite nets
 * $59.94 and is still short. The fixed point is:
 *
 *     charge = (net + fixed) / (1 - pct)
 *
 * At 2.9% + 30¢, netting $60 means charging $62.12: Stripe takes $1.80 + $0.30 = $2.10, which
 * leaves exactly $60. The difference from the naive version is small per session and is money
 * Keoni was losing on every single one.
 *
 * ROUNDED UP, not to nearest. A half-cent rounded down is a half-cent Melanite eats, on every
 * transaction, for ever — and the provider cannot tell the difference between $62.12 and
 * $62.13. When the rounding has to fall on somebody it falls on the party who chose the price.
 *
 * THE RATE IS AN ESTIMATE AND THIS IS THE HONEST PART. Stripe charges 2.9% + 30¢ on a standard
 * domestic card, more on Amex, more again on an international one, more still with currency
 * conversion. One configured rate cannot be right for every card. So this predicts, the charge
 * records what Stripe ACTUALLY took from the balance transaction, and the difference between
 * the two is visible on the revenue page — which is what lets Keoni set the rate from real
 * figures rather than from a guess. Setting it to cover the worst card over-recovers slightly
 * on the best one; that is a pricing decision and hers to make.
 */
export function grossUpForProcessing(input: {
  netCents: number
  /** Stripe's percentage as a fraction — 0.029 for 2.9%. */
  pct: number
  /** Stripe's per-transaction charge, in cents. 30 for 30¢. */
  fixedCents: number
}): Processing {
  assertWhole(input.netCents, 'net amount')
  assertWhole(input.fixedCents, 'fixed fee')

  if (!Number.isFinite(input.pct) || input.pct < 0 || input.pct >= 1) {
    throw new RangeError(`processing rate must be a fraction below 1, got ${input.pct}`)
  }

  // Zero stays zero. A pack-covered session charges nothing, and adding 30¢ of processing to
  // nothing would turn a free session into a card transaction.
  if (input.netCents === 0) {
    return { chargeCents: 0, estimatedFeeCents: 0, netCents: 0 }
  }

  const chargeCents = Math.ceil((input.netCents + input.fixedCents) / (1 - input.pct))

  // Derived from the charge rather than assumed, so the three numbers always reconcile exactly
  // even after the rounding above. `net` here is what Melanite expects to keep, which is a
  // cent or so MORE than it asked for — never less, which is the point of rounding up.
  const estimatedFeeCents = Math.round(chargeCents * input.pct) + input.fixedCents

  return {
    chargeCents,
    estimatedFeeCents,
    netCents: chargeCents - estimatedFeeCents,
  }
}
