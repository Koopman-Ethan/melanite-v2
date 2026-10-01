// What Melanite charges a provider to use the laser, per session.
//
// The rental model replaces the 50/50 split: a provider bills their own client on their own
// system, and pays Melanite this fee for the equipment. The figures come from Keoni's "Laser
// Rental Pricing Guide" (research dated 8 September 2026), which sets each fee at roughly half the
// average local market price — so the economics land near the old split while everything the
// provider charges above it is theirs.
//
// IN CODE, NOT IN THE DATABASE, and for a specific reason: `scripts/etl/load.ts` truncates
// `services`, so anything hung off that table can be erased by an import. The catalogue's duration
// data lives in `scripts/etl/catalogue.ts` for exactly this reason and this follows it. It is also
// what somebody is agreeing to pay, which `docs/decisions.md` has repeatedly said belongs in a
// reviewed commit rather than a form field.
//
// KEYED BY SERVICE NAME, which is this codebase's stable catalogue key — `catalogue.ts` matches on
// name too. A rename is therefore a fee change and must be made deliberately in both places;
// `test/rental-fees.test.ts` pins the mapping so a rename cannot happen quietly.
//
// TIERS ARE MELANITE'S, NOT THE CLIENT'S. Migration 0024 deliberately retired XS/Small/Medium/Large
// as bookable services because "is a Brazilian medium?" is not a question a booking page can settle
// with a client. That objection does not apply here: the provider still picks "Laser Hair Removal —
// Brazilian" exactly as they do today, and this table is consulted behind the scenes to work out
// what Melanite bills. The bracket never reaches a client.

/** Cents, because `lib/money.ts` works in cents and a fee that arrives as a float is a fee that
 *  eventually disagrees with Stripe by a penny. */
export interface RentalFee {
  /** One session. */
  singleCents: number
  /** Pre-bought blocks, cheaper per session. The guide prices 6- and 8-packs for hair removal,
   *  8-packs for tattoo removal and 3-packs for the skin treatments; a tier with no entry here
   *  simply has no pack rate published yet. */
  packs: readonly { sessions: number; cents: number }[]
}

export interface RentalTier {
  key: string
  /** Shown to Keoni in admin, never to a provider's client. */
  label: string
  fee: RentalFee
}

const usd = (dollars: number) => Math.round(dollars * 100)

/**
 * Every tier the pricing guide defines.
 *
 * Hair removal is bracketed by area size; tattoo removal by the size of the tattoo; the skin
 * treatments are priced per area directly.
 */
export const RENTAL_TIERS: readonly RentalTier[] = [
  {
    key: 'lhr_xs',
    label: 'Hair removal — XS (lip, chin, brows, fingers)',
    fee: {
      singleCents: usd(40),
      packs: [
        { sessions: 6, cents: usd(185) },
        { sessions: 8, cents: usd(265) },
      ],
    },
  },
  {
    key: 'lhr_small',
    label: 'Hair removal — Small (underarms, jawline, bikini, neck)',
    fee: {
      singleCents: usd(60),
      packs: [
        { sessions: 6, cents: usd(245) },
        { sessions: 8, cents: usd(295) },
      ],
    },
  },
  {
    key: 'lhr_medium',
    label: 'Hair removal — Medium (Brazilian, full face, half limbs, abs)',
    fee: {
      singleCents: usd(90),
      packs: [
        { sessions: 6, cents: usd(395) },
        { sessions: 8, cents: usd(450) },
      ],
    },
  },
  {
    key: 'lhr_large',
    label: 'Hair removal — Large (full arms, chest, back, full legs)',
    fee: {
      singleCents: usd(130),
      packs: [
        { sessions: 6, cents: usd(625) },
        { sessions: 8, cents: usd(775) },
      ],
    },
  },

  {
    key: 'tattoo_xxs',
    label: 'Tattoo removal — XXS (smaller than a quarter)',
    fee: { singleCents: usd(50), packs: [{ sessions: 8, cents: usd(325) }] },
  },
  {
    key: 'tattoo_xs',
    label: 'Tattoo removal — XS (smaller than a credit card)',
    fee: { singleCents: usd(87), packs: [{ sessions: 8, cents: usd(575) }] },
  },
  {
    key: 'tattoo_small',
    label: 'Tattoo removal — Small (smaller than a dollar bill)',
    fee: { singleCents: usd(112), packs: [{ sessions: 8, cents: usd(725) }] },
  },
  {
    key: 'tattoo_medium',
    label: 'Tattoo removal — Medium (size of one hand)',
    fee: { singleCents: usd(150), packs: [{ sessions: 8, cents: usd(1000) }] },
  },
  {
    key: 'tattoo_large',
    label: 'Tattoo removal — Large (size of two hands)',
    fee: { singleCents: usd(200), packs: [{ sessions: 8, cents: usd(1300) }] },
  },

  {
    key: 'clearlift_face',
    label: 'ClearLift — full face',
    fee: {
      singleCents: usd(185),
      packs: [
        { sessions: 3, cents: usd(500) },
        { sessions: 6, cents: usd(900) },
      ],
    },
  },
  {
    key: 'clearlift_lip',
    label: 'ClearLift — lip or focused area',
    fee: { singleCents: usd(70), packs: [] },
  },
] as const

/**
 * Which tier each bookable service falls into.
 *
 * The hair removal brackets are the guide's own examples, read onto the twelve named areas the
 * catalogue actually offers.
 *
 * ONE JUDGEMENT CALL, flagged rather than buried: the guide lists "abs" under Medium and
 * "chest/abs" under Large. Abs is therefore in both. It is read here as Medium on its own and
 * Large when combined with the chest, which is what the separate `— Abs` and `— Chest` services
 * already distinguish. Worth confirming with Keoni.
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

  'ClearLift': 'clearlift_face',
  'ClearLift Lip Plumper': 'clearlift_lip',
}

/**
 * Bookable services the guide does not price, and the question each one raises.
 *
 * Listed explicitly rather than left to fall through, because a service with no fee must not
 * quietly become a free session. `rentalFeeFor` returns null for these and the booking path is
 * expected to refuse rather than charge nothing — a loud gap is recoverable, a silent $0 is not.
 *
 * The first three are the same structural problem: the guide prices IPL and ClearLift BY AREA, but
 * the catalogue carries one generic service and puts the area in `bookings.treatmentArea` as free
 * text. Either those services get split the way hair removal was in migration 0024, or each takes
 * one flat fee regardless of area.
 */
export const UNPRICED: Readonly<Record<string, string>> = {
  IPL:
    'The guide prices Dye-VL/IPL by area — face $150, neck $100, chest $135, hands $75 — but the ' +
    'catalogue has one generic IPL service with the area as free text on the booking. Split the ' +
    'service by area, or pick one flat fee.',
  'Facial Vein Removal':
    'Possibly the guide\'s "20 min VascuPen" at $45, but that is an inference from the name and ' +
    'has not been confirmed.',
  'Sunspot Removal':
    'Not in the guide. Likely IPL-based, which would make it an area question like IPL itself.',
  'Carbon Laser Treatment': 'Not in the guide at all. Needs a fee before it can be booked.',
}

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
  return tierForService(serviceName)?.fee.singleCents ?? null
}

/** The pack rate for a given block size, or null when that tier publishes no such pack. */
export function packFeeFor(serviceName: string, sessions: number): number | null {
  const tier = tierForService(serviceName)
  if (!tier) return null
  return tier.fee.packs.find((p) => p.sessions === sessions)?.cents ?? null
}

/** Every pack size this service can be pre-bought in. Empty when none are published. */
export function packsFor(serviceName: string): readonly { sessions: number; cents: number }[] {
  return tierForService(serviceName)?.fee.packs ?? []
}
