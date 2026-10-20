import { percentDiscountCents } from '@/lib/money'

// A temporary reduction on the rental fee.
//
// The pure half, deliberately with no `server-only`: the booking form prices a slot in the
// browser and the charge prices a session on the server, and both have to reach the same
// figure. The same split as `lib/rental-fees.ts` (what a tier IS) against
// `lib/rental/schedule.ts` (what it costs) — structure in a pure module, numbers in the
// database.
//
// WHY A PROMOTION IS NOT A SCHEDULE EDIT. A published schedule is immutable AND accepted: every
// provider is blocked from booking until they accept the version in force
// (`providersNeedingReacceptance`). Running a week of 25% off by publishing prices would lock
// everybody out twice — once when it started and once when it ended — which is the opposite of
// what a promotion is for.
//
// WHAT MAKES A SEPARATE LAYER LEGITIMATE. A promotion only ever REDUCES what a provider pays.
// The schedule is the ceiling they agreed to; charging less than the ceiling needs no
// agreement. That is why neither kind below can express an increase — the shape is the
// guarantee, not a validation somebody could forget.
//
// DATES, NOT TIMESTAMPS. A promotion runs over calendar days in Denver and both ends are
// inclusive: "to 31 Oct" includes sessions on the 31st. Anything finer is a cliff edge in the
// middle of somebody's working day, and a human setting a promotion is thinking in days.

/** How the reduction is expressed. The same two forms as the `discount_type` enum, whose own
 *  comment explains why both are kept rather than collapsed to a percentage: "$15 off" and
 *  "25% off" are different promises and reading back the one that was made matters. */
export type PromotionKind = 'percent' | 'amount'

export interface Promotion {
  id: string
  /** What Keoni called it. Shown to providers, so it is a name and not a note. */
  name: string
  /** Which tier it reduces. NULL is every tier — the usual "10% off everything in November". */
  tierKey: string | null
  kind: PromotionKind
  /** A percentage 1–99, or cents off. Which one is decided by `kind`. */
  value: number
  /** `YYYY-MM-DD` in Denver, both inclusive. */
  startsOn: string
  endsOn: string
}

/**
 * The Denver calendar date at an instant, as `YYYY-MM-DD`.
 *
 * `en-CA` because it formats that way, which is also what `<input type="date">` wants — the
 * same idiom as `todayInDenver` in `lib/validation.ts`. Here rather than imported from there
 * because this module is shared with the browser and `lib/validation.ts` pulls in more than a
 * date formatter.
 *
 * UTC WOULD BE WRONG, not merely imprecise: from about 5pm Denver onwards `toISOString()` is
 * already tomorrow, so an evening session on a promotion's last day would miss it.
 */
export function denverYmd(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(at)
}

/** Does this promotion cover this tier? A null `tierKey` covers every one of them. */
export function covers(promo: Promotion, tierKey: string): boolean {
  return promo.tierKey === null || promo.tierKey === tierKey
}

/** Do two promotions ever apply to the same tier on the same day? */
export function overlaps(a: Promotion, b: Promotion): boolean {
  const sameTier = a.tierKey === null || b.tierKey === null || a.tierKey === b.tierKey
  return sameTier && a.startsOn <= b.endsOn && b.startsOn <= a.endsOn
}

/**
 * The promotion covering this tier on this date, or null.
 *
 * ON THE SESSION'S DATE, NOT TODAY, at every call site. Rent is charged about twelve hours
 * after a session ends, so a session on a promotion's last day is swept the NEXT morning —
 * resolving against `now()` would quietly charge full price for a discounted session on every
 * promotion's final day, which is the one bug this signature exists to prevent.
 *
 * Only one can apply: creating a promotion that overlaps an existing one on the same tier is
 * refused (see `lib/validate/promotion.ts`), so "the first match" is "the only match". Taking
 * the first rather than combining is also the safe direction if that rule is ever relaxed —
 * two stacked percentages quietly approach a free session.
 */
export function promotionFor(
  tierKey: string,
  onYmd: string,
  all: readonly Promotion[],
): Promotion | null {
  return (
    all.find((p) => covers(p, tierKey) && p.startsOn <= onYmd && onYmd <= p.endsOn) ?? null
  )
}

/**
 * The fee after a promotion, in cents.
 *
 * CLAMPED AT ZERO, defensively. Creating a promotion that would reduce any tier to nothing is
 * refused up front with a sentence, because a zero fee is not a cheap session but a free one:
 * `grossUpForProcessing` keeps zero at zero and Stripe rejects a charge under 50¢, so it would
 * surface as a failed charge rather than a gift. The clamp is here so an old promotion meeting
 * a newly-lowered schedule price cannot produce a negative.
 */
export function discountedCents(listCents: number, promo: Promotion | null): number {
  if (!promo) return listCents

  const off =
    promo.kind === 'percent' ? percentDiscountCents(listCents, promo.value) : promo.value

  return Math.max(0, listCents - off)
}

/** How a promotion reads to a person: "25% off" / "$15 off". */
export function describePromotion(promo: Promotion): string {
  return promo.kind === 'percent'
    ? `${promo.value}% off`
    : `$${(promo.value / 100).toFixed(2)} off`
}

/** "31 October" for a `YYYY-MM-DD`.
 *
 *  Parsed into parts rather than `new Date(ymd)`, which the spec reads as UTC midnight — so in
 *  Denver it renders as the day BEFORE, and a promotion would appear to end a day early on
 *  every screen that shows it. */
export function prettyDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}
