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
  { n: 4, slug: 'stripe', title: 'Connect Stripe', blurb: 'For automatic payouts' },
  { n: 5, slug: 'director', title: 'Medical Director', blurb: 'Physician oversight' },
  { n: 6, slug: 'services', title: 'Select Services', blurb: 'Set pricing and duration' },
] as const

export type OnboardingSlug = (typeof ONBOARDING_STEPS)[number]['slug']

/** Still setting up. Only ever true for an account created by accepting an invite. */
export function isOnboarding(user: Pick<SessionUser, 'status'>): boolean {
  return user.status === 'pending'
}

/** The step a provider should be on, given how far they have got.
 *
 *  Step 1 happens before the account exists, so anyone with a session is at least on step 2. */
export function nextStepSlug(onboardingStep: number): OnboardingSlug {
  const next = Math.min(Math.max(onboardingStep + 1, 2), 6)
  return ONBOARDING_STEPS.find((s) => s.n === next)!.slug
}

export function stepNumber(slug: OnboardingSlug): number {
  return ONBOARDING_STEPS.find((s) => s.slug === slug)!.n
}

/** May this provider open this step?
 *
 *  Forward only by one — you cannot skip ahead to Stripe without a licence on file — but going
 *  BACK is always allowed. v1 enforced the same rule server-side (`complete_step` had to be at
 *  most `onboarding_step + 1`); revisiting a finished step to fix a typo is not an attack. */
export function canOpenStep(slug: OnboardingSlug, onboardingStep: number): boolean {
  return stepNumber(slug) <= Math.max(onboardingStep + 1, 2)
}
