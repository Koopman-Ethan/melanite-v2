import { describe, expect, it } from 'vitest'

import {
  ONBOARDING_STEPS,
  canOpenStep,
  isOnboarding,
  nextStepSlug,
  stepNumber,
} from '@/lib/onboarding'

// Setup routing. Small, pure, and the thing that decides whether a provider can get into the
// app at all — which is exactly why it is worth pinning down here rather than only in a
// browser test that takes ten seconds and needs a database.

describe('step definitions', () => {
  it('numbers the steps 1..6 with no gaps', () => {
    expect(ONBOARDING_STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('has unique slugs', () => {
    const slugs = ONBOARDING_STEPS.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('agrees with stepNumber in both directions', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(stepNumber(step.slug)).toBe(step.n)
    }
  })
})

describe('isOnboarding', () => {
  it('is true only for pending accounts', () => {
    expect(isOnboarding({ status: 'pending' })).toBe(true)
    expect(isOnboarding({ status: 'active' })).toBe(false)
    expect(isOnboarding({ status: 'inactive' })).toBe(false)
  })

  // The trap this whole design exists to avoid. v1's flow ended at step 5; v2's ends at 6, and
  // every imported provider sits at 5. Gating on the step number would have put nine working
  // providers back into setup on the day this shipped — and step 6 REPLACES their service menu,
  // so it would not have been a harmless detour.
  it('leaves an imported provider stuck at v1 step 5 alone', () => {
    const imported = { status: 'active' as const, onboardingStep: 5 }
    expect(isOnboarding(imported)).toBe(false)
  })
})

describe('nextStepSlug', () => {
  it('sends a freshly activated account to the profile step', () => {
    // Step 1 happens before the account exists, so nobody with a session resumes at it.
    expect(nextStepSlug(1)).toBe('profile')
    expect(nextStepSlug(0)).toBe('profile')
  })

  it('resumes at the step after the last one completed', () => {
    expect(nextStepSlug(2)).toBe('license')
    expect(nextStepSlug(3)).toBe('stripe')
    expect(nextStepSlug(4)).toBe('director')
    expect(nextStepSlug(5)).toBe('services')
  })

  it('clamps at the last step rather than running off the end', () => {
    expect(nextStepSlug(6)).toBe('services')
    expect(nextStepSlug(99)).toBe('services')
  })

  it('never returns a slug that is not a real step', () => {
    for (let step = -5; step <= 20; step++) {
      expect(ONBOARDING_STEPS.some((s) => s.slug === nextStepSlug(step))).toBe(true)
    }
  })
})

describe('canOpenStep', () => {
  it('allows the current step and the next one', () => {
    expect(canOpenStep('license', 2)).toBe(true) // next
    expect(canOpenStep('profile', 2)).toBe(true) // just finished
  })

  it('refuses skipping ahead', () => {
    // Someone who has only set a password cannot jump straight to picking services and
    // activating their own account.
    expect(canOpenStep('services', 1)).toBe(false)
    expect(canOpenStep('stripe', 1)).toBe(false)
    expect(canOpenStep('director', 3)).toBe(false)
  })

  it('always allows going back', () => {
    for (const step of ONBOARDING_STEPS) {
      if (step.n <= 5) expect(canOpenStep(step.slug, 5)).toBe(true)
    }
  })

  it('lets a brand-new account open the profile step', () => {
    // onboardingStep is 1 the moment the invite is claimed, and profile is step 2.
    expect(canOpenStep('profile', 1)).toBe(true)
  })
})
