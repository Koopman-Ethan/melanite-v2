import type { SessionUser } from '@/lib/auth/session'

// Where a provider is in setup, and where they should be sent.
//
// Progress is `providers.onboardingStep`; COMPLETION is `providers.status`. Those are different
// questions and conflating them would have been a mistake here: v1's terminal step was 5, this
// flow's is 6, and all nine imported providers sit at 5. Gating on a step number would have
// trapped every existing provider in onboarding forever. Status is the durable signal.

export const ONBOARDING_STEPS = [
  { n: 1, slug: 'password', title: 'Create Password', blurb: 'Secure your account' },
  { n: 2, slug: 'profile', title: 'Personal Profile', blurb: 'Name, phone, credentials' },
  { n: 3, slug: 'license', title: 'License & Compliance', blurb: 'Verify your credentials' },
  { n: 4, slug: 'billing', title: 'Card on File', blurb: 'For equipment rental' },
  { n: 5, slug: 'director', title: 'Medical Director', blurb: 'Physician oversight' },
  { n: 6, slug: 'services', title: 'Select Services', blurb: 'What you offer, and how long' },
] as const

export type OnboardingSlug = (typeof ONBOARDING_STEPS)[number]['slug']

/** Laser provider, or somebody who only rents the room.
 *
 *  NOTHING PASSES THIS YET — every call site takes the `laser` default, so behaviour is
 *  unchanged for everybody. The flow logic and the column are in place; what is still missing
 *  is how a room renter is asked whether they need a medical director, which is blocked on a
 *  list of procedures from Keoni. See "Room-only providers" in docs/decisions.md.
 *
 *  Left in rather than reverted because the split itself is settled: a room renter brings their
 *  own clients and pays for the room out of pocket, so Connect and the laser service menu do
 *  not apply to them whatever the answer on medical direction turns out to be. */
export type PracticeType = 'laser' | 'room_only'

/** Steps that do not apply to somebody who only rents the room.
 *
 *  `billing` is the card Melanite charges to rent the LASER. A room renter never books laser
 *  time, and the room itself they pay for out of pocket at checkout, which needs nothing set up
 *  in advance — so there is nothing for a card on file to be charged for. This step used to be
 *  the Stripe Connect account that paid them their share of a client's payment; it was excluded
 *  then for the mirror-image reason, that there was no share to pay.
 *
 *  `services` is the Melanite laser catalogue. What a room renter does in that room never
 *  touches this system, so the question does not apply — asking them to pick from a laser menu
 *  would record something untrue.
 *
 *  The medical director step is NOT here. Whether they need one depends on what they perform,
 *  which the app cannot know, so it is asked rather than assumed. */
const NOT_FOR_ROOM_ONLY = new Set<OnboardingSlug>(['billing', 'services'])

export function stepApplies(slug: OnboardingSlug, practice: PracticeType): boolean {
  return practice === 'laser' || !NOT_FOR_ROOM_ONLY.has(slug)
}

/** The steps this provider actually walks, in order. */
export function stepsFor(practice: PracticeType) {
  return ONBOARDING_STEPS.filter((s) => stepApplies(s.slug, practice))
}

/** Still setting up. Only ever true for an account created by accepting an invite. */
export function isOnboarding(user: Pick<SessionUser, 'status'>): boolean {
  return user.status === 'pending'
}

/** The step a provider should be on, given how far they have got.
 *
 *  Step 1 happens before the account exists, so anyone with a session is at least on step 2. */
export function nextStepSlug(
  onboardingStep: number,
  practice: PracticeType = 'laser',
): OnboardingSlug {
  const target = Math.max(onboardingStep + 1, 2)
  const applicable = stepsFor(practice)

  // The first applicable step at or after where they have got to. Numbering stays canonical —
  // `onboardingStep` means the same thing for everybody — while the PATH differs, so a room
  // renter who finishes step 3 lands on 5 rather than being bounced back to a Stripe step that
  // does not apply to them.
  return (applicable.find((s) => s.n >= target) ?? applicable[applicable.length - 1]).slug
}

export function stepNumber(slug: OnboardingSlug): number {
  return ONBOARDING_STEPS.find((s) => s.slug === slug)!.n
}

/** May this provider open this step?
 *
 *  Forward only by one — you cannot skip ahead to Stripe without a license on file — but going
 *  BACK is always allowed. v1 enforced the same rule server-side (`complete_step` had to be at
 *  most `onboarding_step + 1`); revisiting a finished step to fix a typo is not an attack. */
export function canOpenStep(
  slug: OnboardingSlug,
  onboardingStep: number,
  practice: PracticeType = 'laser',
): boolean {
  // A step that does not apply is never openable, whatever the number says. Otherwise a room
  // renter could reach the card step by typing the URL and hand over a card for laser time they
  // will never book.
  if (!stepApplies(slug, practice)) return false

  // Measured against the step they would be SENT to, not against `onboardingStep + 1`.
  //
  // Those differ the moment the path skips something. A room renter finishing licence has
  // `onboardingStep` 3, and their next step is 5 — comparing against 4 refused it, stranding
  // them on a step they had already completed with nowhere legal to go.
  return stepNumber(slug) <= stepNumber(nextStepSlug(onboardingStep, practice))
}
