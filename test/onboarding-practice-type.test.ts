import { describe, expect, it } from 'vitest'

import {
  ONBOARDING_STEPS,
  canOpenStep,
  nextStepSlug,
  stepApplies,
  stepsFor,
} from '@/lib/onboarding'

// Two ways to be a provider here, and they need different setup.
//
// A laser provider books the shared laser and bills clients through Melanite: they need a
// Connect account to be paid, and a service menu to be booked from.
//
// A room renter brings their own clients and pays for the room out of pocket. Melanite never
// touches their client money, so there is nothing to pay them — a Connect account would sit
// empty forever — and the laser catalogue describes nothing they do.
//
// The numbering stays canonical for everybody; only the PATH differs. That is what lets
// `onboardingStep` keep one meaning across both kinds of provider, including the nine imported
// ones who all sit at 5.

describe('which steps apply', () => {
  it('a laser provider walks all six', () => {
    expect(stepsFor('laser').map((s) => s.slug)).toEqual(
      ONBOARDING_STEPS.map((s) => s.slug),
    )
  })

  it('a room renter skips Connect and the service menu', () => {
    expect(stepsFor('room_only').map((s) => s.slug)).toEqual([
      'password',
      'profile',
      'license',
      'director',
    ])
  })

  it('keeps the medical director step for a room renter', () => {
    // Deliberately NOT skipped. Whether they need one depends on what they perform in that
    // room, which the app cannot see — so it is asked, not assumed either way.
    expect(stepApplies('director', 'room_only')).toBe(true)
  })

  it('keeps licence and profile for everybody', () => {
    // A room renter is still a clinician on the premises. Who they are and what licence they
    // hold is exactly the record Melanite has to be able to produce.
    for (const slug of ['profile', 'license'] as const) {
      expect(stepApplies(slug, 'room_only'), slug).toBe(true)
    }
  })
})

describe('where a provider is sent next', () => {
  it('walks a laser provider through in order', () => {
    expect(nextStepSlug(2, 'laser')).toBe('license')
    expect(nextStepSlug(3, 'laser')).toBe('stripe')
    expect(nextStepSlug(4, 'laser')).toBe('director')
    expect(nextStepSlug(5, 'laser')).toBe('services')
  })

  it('jumps a room renter over the steps that do not apply', () => {
    // The one that matters: finishing licence (3) sends them to director (5), not to a Connect
    // step they have no use for. Landing on step 4 would strand them — they cannot complete it,
    // so they could never reach step 5.
    expect(nextStepSlug(3, 'room_only')).toBe('director')
  })

  it('leaves a room renter on the last step that applies to them', () => {
    // There is no step 6 for them, so finishing 5 has nowhere further to go inside setup.
    expect(nextStepSlug(5, 'room_only')).toBe('director')
  })
})

describe('what a provider may open', () => {
  it('refuses a step that does not apply, whatever the number says', () => {
    // Typing the URL is the attack here. A room renter who reached the Connect step would
    // create an Express account nobody will ever pay into, and then be asked to finish
    // onboarding for it.
    expect(canOpenStep('stripe', 5, 'room_only')).toBe(false)
    expect(canOpenStep('services', 5, 'room_only')).toBe(false)
  })

  it('still refuses skipping ahead', () => {
    expect(canOpenStep('director', 2, 'laser')).toBe(false)
    expect(canOpenStep('director', 2, 'room_only')).toBe(false)
  })

  it('still allows going back', () => {
    // Revisiting a finished step to fix a typo is not an attack, and never was.
    expect(canOpenStep('profile', 5, 'laser')).toBe(true)
    expect(canOpenStep('license', 5, 'room_only')).toBe(true)
  })

  it('lets a room renter open the director step straight after licence', () => {
    // Their step 4 is skipped, so `onboardingStep` 3 has to be enough to open step 5.
    expect(canOpenStep('director', 3, 'room_only')).toBe(true)
  })
})
