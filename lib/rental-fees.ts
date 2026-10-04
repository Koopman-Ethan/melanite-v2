// What Melanite charges a provider to use the laser, per session.
//
// The rental model replaces the 50/50 split: a provider bills their own client on their own
// system, and pays Melanite this fee for the equipment. The figures come from Keoni's "Laser
// Rental Pricing Guide" (research dated 8 September 2026, schedule revised 3 October 2026),
// which sets each fee at roughly half the average local market price — so the economics land
// near the old split while everything the provider charges above it is theirs.
//
// NO PACK RATES. The first version of this schedule sold discounted blocks of sessions, and
// Keoni removed them on 3 October: packages are the provider's business to run with their own
// clients, and Melanite selling a discounted block of rental put it back in the middle of a
// pricing decision it had just got out of. `lib/rental/packs.ts` still exists, because a
// provider can be GRANTED fee-free sessions — the cutover owes Karly the ones her clients
// already bought — but nothing is sold.
//
// IN CODE, NOT IN THE DATABASE, and for a specific reason: `scripts/etl/load.ts` truncates
// `services`, so anything hung off that table can be erased by an import. The catalogue's
// duration data lives in `scripts/etl/catalogue.ts` for exactly this reason and this follows it.
// It is also what somebody is agreeing to pay, which `docs/decisions.md` has repeatedly said
// belongs in a reviewed commit rather than a form field.
//
// KEYED BY SERVICE NAME, which is this codebase's stable catalogue key — `catalogue.ts` matches
// on name too. A rename is therefore a fee change and must be made deliberately in both places;
// `test/rental-fees.test.ts` pins the mapping so a rename cannot happen quietly.
//
// TIERS ARE MELANITE'S, NOT THE CLIENT'S. Migration 0024 deliberately retired XS/Small/Medium/Large
// as bookable services because "is a Brazilian medium?" is not a question a booking page can settle
// with a client. That objection does not apply here: the provider still picks "Laser Hair Removal —
// Brazilian" exactly as they do today, and this table is consulted behind the scenes to work out
// what Melanite bills. The bracket never reaches a client.

export interface RentalTier {
  key: string
  /** Shown to Keoni in admin and to a provider on the terms screen. Never to a client. */
  label: string
  /** What one session costs the provider, in cents.
   *
   *  Cents, because `lib/money.ts` works in cents and a fee that arrives as a float is a fee
   *  that eventually disagrees with Stripe by a penny. */
  singleCents: number
  /** What the guide suggests a provider might charge their own client, as a range — the same
   *  figure twice when it names one.
   *
   *  ADVISORY, and the guide is emphatic about it: "not meant for providers to stick with a
   *  certain price point". Carried because the whole document exists to show providers the
   *  market, and a fee shown with no sense of what the treatment sells for is just a cost. The
   *  platform never reads these; they are only ever displayed. */
  suggestedLowCents: number
  suggestedHighCents: number
}

const usd = (dollars: number) => Math.round(dollars * 100)

/** Both ends of a suggested range, or one figure repeated. */
const tier = (
  key: string,
  label: string,
  fee: number,
  suggested: number | [number, number],
): RentalTier => ({
  key,
  label,
  singleCents: usd(fee),
  suggestedLowCents: usd(Array.isArray(suggested) ? suggested[0] : suggested),
  suggestedHighCents: usd(Array.isArray(suggested) ? suggested[1] : suggested),
})

/**
 * Every tier the pricing guide defines.
 *
 * Hair removal is bracketed by area size; tattoo removal by the size of the tattoo; IPL and
 * ClearLift are priced per area directly, which is why the catalogue now carries a service per
 * area — see `scripts/etl/catalogue.ts`.
 */
export const RENTAL_TIERS: readonly RentalTier[] = [
  tier('lhr_xs', 'Hair removal — XS (lip, chin, brows, fingers, areolas)', 35, 80),
  tier('lhr_small', 'Hair removal — Small (underarms, jawline, bikini, neck)', 60, 125),
  tier('lhr_medium', 'Hair removal — Medium (Brazilian, full face, half limbs, shoulders, abs)', 95, 195),
  tier('lhr_large', 'Hair removal — Large (full arms, chest, back, full legs)', 120, [250, 350]),

  tier('tattoo_xxs', 'Tattoo removal — XXS (smaller than a quarter)', 50, 100),
  tier('tattoo_xs', 'Tattoo removal — XS (smaller than a credit card)', 85, 175),
  tier('tattoo_small', 'Tattoo removal — Small (smaller than a dollar bill)', 110, 225),
  tier('tattoo_medium', 'Tattoo removal — Medium (size of one hand)', 150, 300),
  tier('tattoo_large', 'Tattoo removal — Large (size of two hands)', 200, 400),

  tier('ipl_face', 'Dye-VL / IPL — Full face', 150, 325),
  tier('ipl_neck', 'Dye-VL / IPL — Neck', 100, 200),
  tier('ipl_chest', 'Dye-VL / IPL — Chest', 135, 300),
  tier('ipl_hands', 'Dye-VL / IPL — Hands', 75, 175),
  tier('vascupen', 'VascuPen — 20 minutes', 45, [75, 150]),

  tier('clearlift_face', 'ClearLift / Carbon — Full face', 175, [350, 400]),
  tier('clearlift_neck', 'ClearLift — Neck', 95, [195, 250]),
  tier('clearlift_hands', 'ClearLift — Hands', 85, [150, 225]),
  tier('clearlift_lip', 'ClearLift — Lip', 70, [125, 150]),
  tier('sunspots', 'Sunspot removal', 45, [95, 150]),
]

/**
 * Which tier each bookable service falls into.
 *
 * The hair removal areas follow the guide's bracket examples. The skin treatments map one to
 * one, now that the catalogue carries a service per area — until 3 October there was a single
 * generic `IPL` with the area typed into `bookings.treatmentArea` as free text, which could not
 * be priced at all. Keoni's instruction was "I do want to have separate areas because people
 * charge different prices for each area", so the catalogue was split to match the schedule.
 */
export const SERVICE_TIER: Readonly<Record<string, string>> = {
  'Laser Hair Removal — Upper Lip': 'lhr_xs',
  'Laser Hair Removal — Chin': 'lhr_xs',

  'Laser Hair Removal — Underarms': 'lhr_small',
  'Laser Hair Removal — Bikini': 'lhr_small',

  'Laser Hair Removal — Brazilian': 'lhr_medium',
  'Laser Hair Removal — Full Face': 'lhr_medium',
  'Laser Hair Removal — Half Arms': 'lhr_medium',
  'Laser Hair Removal — Half Legs': 'lhr_medium',
  // The guide lists abs under Medium and "chest/abs" under Large, so abs appears twice. Read as
  // Medium, because the Large examples are all torso-sized. Pinned in the tests so it is
  // re-made deliberately rather than drifting.
  'Laser Hair Removal — Abs': 'lhr_medium',

  'Laser Hair Removal — Full Arms': 'lhr_large',
  'Laser Hair Removal — Chest': 'lhr_large',
  'Laser Hair Removal — Back': 'lhr_large',
  'Laser Hair Removal — Full Legs': 'lhr_large',

  'Tattoo Removal (XXSmall)': 'tattoo_xxs',
  'Tattoo Removal (XSmall)': 'tattoo_xs',
  'Tattoo Removal (Small)': 'tattoo_small',
  'Tattoo Removal (Medium)': 'tattoo_medium',
  'Tattoo Removal (Large)': 'tattoo_large',

  'IPL — Full Face': 'ipl_face',
  'IPL — Neck': 'ipl_neck',
  'IPL — Chest': 'ipl_chest',
  'IPL — Hands': 'ipl_hands',
  // Keoni, 3 October: "the facial vein removal is the 20 min VascuPen".
  'Facial Vein Removal': 'vascupen',

  'ClearLift': 'clearlift_face',
  // Keoni, 3 October: "the carbon laser treatment can be the same price as the clearlift
  // treatment". Same tier rather than a duplicate entry, so the two can never drift apart.
  'Carbon Laser Treatment': 'clearlift_face',
  'ClearLift — Neck': 'clearlift_neck',
  'ClearLift — Hands': 'clearlift_hands',
  'ClearLift Lip Plumper': 'clearlift_lip',
  'Sunspot Removal': 'sunspots',
}

/**
 * Bookable services the guide does not price, and the question each one raises.
 *
 * EMPTY since 3 October 2026, when Keoni priced the last four. Kept rather than deleted,
 * because the mechanism is what matters: a service with no fee must not quietly become a free
 * session, and the next one added to the catalogue needs somewhere to be listed while it waits
 * for a price. `rentalFeeFor` returns null for anything in here and the booking path refuses —
 * a loud gap is recoverable, a silent $0 is not.
 *
 * `test/rental-fee-coverage.test.ts` fails if an active service is in neither table, so adding
 * a service without pricing it cannot pass unnoticed.
 */
export const UNPRICED: Readonly<Record<string, string>> = {}

const TIER_BY_KEY = new Map(RENTAL_TIERS.map((t) => [t.key, t]))

/** The tier with this key, or null when nothing in the schedule has it.
 *
 *  Provider packs store a tier key rather than referencing a row, because the schedule lives in
 *  code. This is the lookup that turns a stored key back into a fee, and the null it can return is
 *  what `test/rental-packs.test.ts` exists to keep impossible. */
export function tierByKey(key: string): RentalTier | null {
  return TIER_BY_KEY.get(key) ?? null
}

/** The tier a service falls into, or null when the guide does not price it. */
export function tierForService(serviceName: string): RentalTier | null {
  const key = SERVICE_TIER[serviceName]
  return key ? (TIER_BY_KEY.get(key) ?? null) : null
}

/**
 * What one session of this service costs the provider, in cents.
 *
 * NULL means "no published fee", which is a refusal rather than a free session — see `UNPRICED`.
 * Callers must treat null as "cannot be booked yet", never as zero.
 */
export function rentalFeeFor(serviceName: string): number | null {
  return tierForService(serviceName)?.singleCents ?? null
}
