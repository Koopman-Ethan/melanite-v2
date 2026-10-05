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
 *  is what a version bump is for. */
export const RENTAL_TERMS_VERSION = '2026-10-04.v2'

export interface RentalTerm {
  /** Stable key. Survives rewording, so a change in phrasing is not a change in substance. */
  key: string
  text: string
}

/**
 * The terms, as the provider sees them.
 *
 * Written as what Melanite will DO rather than as what the provider must not do — every line
 * here is something the platform actually enforces, and a term the code does not implement is
 * a term that quietly becomes false.
 */
export const RENTAL_TERMS: readonly RentalTerm[] = [
  {
    key: 'fee_per_session',
    text:
      'Melanite charges a rental fee for each session you book, taken from your card at the ' +
      'moment you reserve the time. The fee depends on the service and is shown before you book.',
  },
  {
    key: 'decline_no_booking',
    text:
      'If the card is declined the appointment is not made. The laser is shared, so a slot ' +
      'cannot be held against a fee that has not been paid.',
  },
  {
    key: 'your_clients_your_business',
    text:
      'You bill your own clients, at your own prices, through your own system. Melanite does ' +
      'not take a share of what you charge and does not keep any record of your clients.',
  },
  {
    key: 'no_show_refund',
    text:
      'If your client does not turn up, mark the appointment as a no-show and the rental fee ' +
      'for that session is refunded. The same applies if you cancel.',
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
      'Selling your clients packages, memberships or promotions is entirely your decision. ' +
      'Melanite charges the same rental fee per session however you have priced it.',
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
      'your next booking, and a change never alters the price of a pack you have already bought.',
  },
] as const

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
 *  — so there is no schedule to be out of date with and that half of the gate is open. */
export function hasAcceptedRentalTerms(
  provider:
    | { rentalTermsVersion: string | null; rentalScheduleVersion?: number | null }
    | null
    | undefined,
  liveSchedule: number | null = null,
): boolean {
  if (provider?.rentalTermsVersion !== RENTAL_TERMS_VERSION) return false
  if (liveSchedule === null) return true
  return provider?.rentalScheduleVersion === liveSchedule
}
