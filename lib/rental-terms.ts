// What a provider agrees to when they rent the laser.
//
// IN CODE AND VERSIONED, the same as `lib/end-of-use.ts` and for the same reason: this is
// something a person agreed to on a particular day, and "what did they agree to" has to stay
// answerable after the wording changes. A provider's acknowledgement records the VERSION, so a
// later edit never rewrites what somebody already accepted.
//
// Not in `platform_settings` and not in a form field. Terms somebody can edit without review
// are terms nobody can be held to, and the fee schedule they point at lives in code for exactly
// the same reason — see the header of `lib/rental-fees.ts`.
//
// BUMP THE VERSION whenever the substance changes, never for a typo. Bumping it means every
// provider is asked again, which is correct for a change in what they owe and merely annoying
// for a comma. `test/rental-terms.test.ts` pins the current version so a change is deliberate.

/** Date-stamped, like `END_OF_USE_VERSION`, so the order of two versions is readable.
 *
 *  v2, 4 October 2026: Melanite stopped selling session packs, so the term describing them was
 *  replaced by one about credited sessions, and a term was added saying that packaging and
 *  promotions are the provider's own business. Both change what somebody is agreeing to, which
 *  is what a version bump is for.
 *
 *  v3, 7 October 2026: the automatic refund is gone. A cancellation or a no-show no longer
 *  returns the fee by itself — the provider says what happened and Melanite decides. v2 told
 *  providers in as many words that marking a no-show got their money back, and a provider still
 *  holding that belief would plan around it.
 *
 *  v5, 19 October 2026: the biggest bump, and the one that had gone furthest out of date.
 *
 *  Two terms were simply FALSE by the time this was written. `fee_per_session` said the fee was
 *  taken "at the moment you reserve the time" — it has been taken twelve hours after the session
 *  ends since 9 October, which is the opposite end of the arrangement. `decline_no_booking` said
 *  a declined card meant no appointment, which stopped being true the same day, because there is
 *  no card transaction at booking to decline. A term the code does not implement is a term that
 *  quietly becomes false, and these two had.
 *
 *  Then the 14 October changes, which need saying out loud: packages and prepaid balances are
 *  gone for everybody, Melanite never charges a client anything, and Leyla, Brittany and Karly
 *  pay half of what they charged their own client rather than the published fee — confirmed
 *  against a receipt they send Keoni, before any card is touched.
 *
 *  THE THREE HAVE NEVER ACCEPTED RENTAL TERMS AT ALL. They were on the 50/50 through every
 *  version above, so this is not a re-acceptance for them, it is the first one. There is no
 *  v4: it was drafted for the 12 October hybrid, which lasted two days and never shipped. */
export const RENTAL_TERMS_VERSION = '2026-10-19.v5'

export interface RentalTerm {
  /** Stable key. Survives rewording, so a change in phrasing is not a change in substance. */
  key: string
  text: string
  /** Only shown to providers on this rent basis. Omitted means everybody sees it.
   *
   *  Added in v5 because one term is true of exactly three people, and showing it to the other
   *  six would describe an arrangement they are not on. The alternative — two separate lists —
   *  is how one of them stops being maintained. */
  basis?: 'tier' | 'half_own_price'
}

/**
 * The terms, as the provider sees them.
 *
 * Written as what Melanite will DO rather than as what the provider must not do — every line
 * here is something the platform actually enforces, and a term the code does not implement is
 * a term that quietly becomes false. v5 exists because two of them had.
 */
export const RENTAL_TERMS: readonly RentalTerm[] = [
  {
    key: 'fee_per_session',
    text:
      'Melanite charges a rental fee for each session you book. It is taken from your card ' +
      'after the session, not when you reserve the time, and the amount is shown to you before ' +
      'you book.',
  },
  {
    key: 'card_on_file',
    text:
      'You keep a card on file. Because the fee is taken after the session rather than before ' +
      'it, the card is what settles what you have already used, and Melanite will not let you ' +
      'book new time while rent is outstanding on sessions you have had.',
  },
  {
    // Key kept from v2 and v3, when this term promised an automatic refund. The TOPIC is
    // unchanged — what becomes of the fee when a session does not go ahead — and the key is
    // meant to survive a rewording so the history of one term stays followable.
    key: 'no_show_refund',
    text:
      'If a session does not go ahead, cancel it or mark it a no-show and tell Melanite what ' +
      'happened. The rental fee is not written off automatically: Melanite reads what you ' +
      'wrote and decides whether it is owed, because whose fault it was is not something the ' +
      'system can see. You are told either way.',
  },
  {
    key: 'late_cancellation',
    text:
      'You are only asked what happened when a session is called off within 24 hours of the ' +
      'start, or missed. Cancel earlier than that and the slot simply goes back, with nothing ' +
      'owed and nothing to explain.',
  },
  {
    key: 'your_clients_your_business',
    text:
      'You bill your own clients, at your own prices, through your own system. Melanite takes ' +
      'no payment from your clients, charges them nothing if they miss an appointment, and ' +
      'keeps no record of who they are.',
  },
  {
    key: 'half_own_price',
    basis: 'half_own_price',
    text:
      'Your rental fee is half of what you charged your client for that service, rather than ' +
      'the published fee. Send Melanite the receipt for each session; Keoni confirms the ' +
      'amount against it and only then is your card charged. Nothing is taken automatically.',
  },
  {
    key: 'granted_sessions',
    text:
      'If Melanite has credited you fee-free sessions — for work your clients paid for before ' +
      'the rental model, for instance — they are used automatically, oldest first, and nothing ' +
      'is charged to your card while one remains. They do not expire.',
  },
  {
    key: 'your_own_packages',
    text:
      'Selling your clients packages, memberships or promotions is entirely your decision, and ' +
      'you run them yourself. Melanite no longer sells packages or holds prepaid balances for ' +
      'anybody, and charges the same rental fee per session however you have priced it.',
  },
  {
    key: 'closeout',
    text:
      'You complete the end-of-use checklist after every appointment, and report any device ' +
      'fault with a photograph at the time you find it.',
  },
  {
    key: 'fee_changes',
    text:
      'Melanite may change the fee schedule. You will be asked to accept the new terms before ' +
      'your next booking, and a change never alters what you owe for a session you have ' +
      'already had.',
  },
] as const

/** The terms this provider is actually agreeing to.
 *
 *  Filtered rather than branched, so there is one list and one place a term is written. A
 *  provider on the published schedule must not be shown the half-their-own-price term: it would
 *  describe an arrangement they are not on, and a consent screen that says things that are not
 *  true of the reader is how the whole screen stops being read.
 */
export function rentalTermsFor(basis: 'tier' | 'half_own_price'): readonly RentalTerm[] {
  return RENTAL_TERMS.filter((t) => t.basis === undefined || t.basis === basis)
}

/** The fee schedule is part of what is being agreed to, so the screen showing these terms shows
 *  it too. Kept here as a pointer rather than a copy — two lists of prices disagree eventually. */
export const RENTAL_TERMS_FEE_NOTE =
  'The current fee for every service is listed above and in the booking form.'

/** Has this provider accepted what is in force now — both the prose and the prices?
 *
 *  TWO VERSIONS, because the two change for different reasons. The terms above are edited in a
 *  reviewed commit; the fee schedule is published by Keoni from the admin, and lives in
 *  `rental_fee_schedules`. A provider has to be current on both, and the reason is the same in
 *  each case: they agreed to a specific thing, and this compares against that thing rather
 *  than against "did they ever agree to anything".
 *
 *  A null `liveSchedule` means nothing has been published yet — the seeding script has not run
 *  — so there is no schedule to be out of date with and that half of the gate is open.
 *
 *  `rentalScheduleVersion` IS REQUIRED, and was optional for about a day. The account page did
 *  not select it, so it arrived as undefined, never equalled the live version, and showed a
 *  provider a "the prices have changed" banner that accepting did not clear — it wrote the
 *  right row and re-rendered the same screen. Optional meant the compiler could not say so.
 *  Required means a caller that forgets the column does not build. */
export function hasAcceptedRentalTerms(
  provider:
    | { rentalTermsVersion: string | null; rentalScheduleVersion: number | null }
    | null
    | undefined,
  liveSchedule: number | null = null,
): boolean {
  if (provider?.rentalTermsVersion !== RENTAL_TERMS_VERSION) return false
  if (liveSchedule === null) return true
  return provider?.rentalScheduleVersion === liveSchedule
}
