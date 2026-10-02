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

/** Date-stamped, like `END_OF_USE_VERSION`, so the order of two versions is readable. */
export const RENTAL_TERMS_VERSION = '2026-10-02.v1'

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
    key: 'packs',
    text:
      'Sessions bought in advance as a pack are spent automatically, oldest pack first, and ' +
      'nothing is charged to your card while a session remains. Packs are not refundable for ' +
      'cash and do not expire.',
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

/** Has this provider accepted the terms that are in force now?
 *
 *  Compares the VERSION, not merely "is there an acknowledgement". A provider who accepted an
 *  older set has not agreed to this one, which is the entire reason the version is stored. */
export function hasAcceptedRentalTerms(
  provider: { rentalTermsVersion: string | null } | null | undefined,
): boolean {
  return provider?.rentalTermsVersion === RENTAL_TERMS_VERSION
}
