// Known-bad values in the v1 source, and what to do about them.
//
// Declared here rather than fixed by hand after an import, for three reasons:
//
//   1. A hand-edit is invisible. verify-providers.ts compares the database against Xano, so a
//      manual correction looks exactly like a transform bug — same symptom, opposite cause.
//      It flagged my own cleanup within seconds of my doing it, which is how this file exists.
//   2. It has to happen again. Production imports the same Xano data, and the nightly
//      prod->dev copy will too. Anything not written down gets forgotten on the run that
//      matters.
//   3. It is a record. Deleting somebody's Stripe account id is a decision, and a decision
//      with a reason attached can be argued with later.
//
// A correction is not a silent fix. Both the transform and the verifier print what they
// applied, so a run that quietly did something is impossible.

export interface ProviderCorrection {
  email: string
  /** Fields whose v1 value is wrong, and the value to use instead. */
  set: {
    stripeAccountId?: null
    stripeOnboardingComplete?: boolean
    bookingEnabled?: boolean
  }
  reason: string
}

export const PROVIDER_CORRECTIONS: ProviderCorrection[] = [
  {
    email: 'melanitelasersuite@gmail.com',
    set: { stripeAccountId: null, stripeOnboardingComplete: false, bookingEnabled: false },
    reason:
      "v1 holds acct_1Tb4qy9GqPAHH83D, which is not on the platform — deleted, or from another " +
      "account. Bookings use destination charges, so keeping it means a client reaches checkout " +
      "and the payment is rejected. Keoni's account is administrative and takes no clients, so " +
      'booking is off too rather than left claiming a capability she does not use.',
  },
  {
    email: 'ethan.koopman@gmail.com',
    set: { bookingEnabled: false },
    reason:
      'Developer account. Booking-enabled in v1 with no licence and no services, which made it ' +
      'clear the licence gate — that gate reads a null expiry as valid.',
  },
  {
    email: 'testprovider@melanitesuite.com',
    set: { stripeAccountId: null, stripeOnboardingComplete: false, bookingEnabled: false },
    reason:
      'A test account carrying the placeholder acct_TEST0000000000000. The suite creates its ' +
      'own throwaway providers now, so this one earns nothing. Left in place rather than ' +
      'deleted: it owns ledger rows, and the ledger is append-only.',
  },
]

/** Corrections keyed by the email they apply to. */
export const correctionsByEmail = new Map(
  PROVIDER_CORRECTIONS.map((correction) => [correction.email.toLowerCase(), correction]),
)

/** True when this field on this provider is a declared, deliberate divergence from v1. */
export function isCorrected(email: string, field: keyof ProviderCorrection['set']): boolean {
  const correction = correctionsByEmail.get(email.toLowerCase())
  return correction ? field in correction.set : false
}
