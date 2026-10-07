import { describe, expect, it } from 'vitest'

import {
  RENTAL_TERMS,
  RENTAL_TERMS_VERSION,
  hasAcceptedRentalTerms,
} from '@/lib/rental-terms'

// What a provider agreed to, and when.
//
// Pure logic, no database. The valuable test here is the frozen version: bumping it asks every
// provider to accept again and blocks their next booking until they do, so it must never happen
// by accident — a tidy-up of the wording that also moved the version would lock five people out
// of the calendar on a Monday morning.

describe('the version', () => {
  it('is the one currently in force', () => {
    // Change this deliberately, at the same time as the terms themselves, and never for a typo.
    expect(RENTAL_TERMS_VERSION).toBe('2026-10-07.v3')
  })

  it('sorts after an earlier version', () => {
    // Date-stamped so two versions can be compared as strings, the same as END_OF_USE_VERSION.
    expect(RENTAL_TERMS_VERSION > '2026-09-01.v1').toBe(true)
  })
})

describe('whether somebody has accepted', () => {
  it('accepts the current version', () => {
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: RENTAL_TERMS_VERSION, rentalScheduleVersion: null })).toBe(true)
  })

  it('refuses an older one', () => {
    // The whole reason the version is stored rather than just a timestamp. Someone who accepted
    // last year's fee schedule has not agreed to this one.
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: '2026-01-01.v1', rentalScheduleVersion: null })).toBe(false)
  })

  it('refuses somebody who has never accepted', () => {
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: null, rentalScheduleVersion: null })).toBe(false)
    expect(hasAcceptedRentalTerms(null)).toBe(false)
    expect(hasAcceptedRentalTerms(undefined)).toBe(false)
  })
})

describe('accepting it actually clears the prompt', () => {
  it('is satisfied by exactly what a provider row holds after accepting', () => {
    // The shape `acceptRentalTerms` writes. This is the regression: the account page compared
    // against a column it never selected, so the value arrived as undefined, never matched, and
    // the banner it drives could not be dismissed — accepting wrote the right row and
    // re-rendered the identical screen.
    const afterAccepting = { rentalTermsVersion: RENTAL_TERMS_VERSION, rentalScheduleVersion: 3 }
    expect(hasAcceptedRentalTerms(afterAccepting, 3)).toBe(true)
  })

  it('is not satisfied when the schedule version is missing rather than wrong', () => {
    // A provider who has genuinely never accepted a schedule. Correct to refuse — but it is
    // also what a forgotten column looks like, which is why the parameter is required and a
    // caller that omits it does not compile.
    expect(
      hasAcceptedRentalTerms(
        { rentalTermsVersion: RENTAL_TERMS_VERSION, rentalScheduleVersion: null },
        3,
      ),
    ).toBe(false)
  })
})

describe('the terms themselves', () => {
  it('has no duplicate keys', () => {
    const keys = RENTAL_TERMS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('states each of the things the platform actually enforces', () => {
    // Every key here corresponds to behaviour in code. Dropping one means the platform does
    // something to a provider's money that they were never told about, which is the failure
    // this list exists to prevent — so removing one has to break a test.
    //
    //   fee_per_session      chargeRentalFee, from createBooking
    //   decline_no_booking   createBooking deletes the booking on a declined card
    //   no_show_refund       heldRentalFor gates markNoShow and cancelBooking; the fee is held
  //                        and reviewRentalFee settles it. NOT releaseRentalForBooking any more —
  //                        that is now reachable only from Keoni's queue.
    //   granted_sessions     claimPackSession, oldest first
    //   fee_changes          hasAcceptedRentalTerms gates createBooking
    const keys = RENTAL_TERMS.map((t) => t.key)
    for (const required of [
      'fee_per_session',
      'decline_no_booking',
      'no_show_refund',
      'granted_sessions',
      'fee_changes',
    ]) {
      expect(keys, `${required} is enforced in code but no longer stated`).toContain(required)
    }
  })

  it('says something substantive for every term', () => {
    for (const term of RENTAL_TERMS) {
      expect(term.text.length, `${term.key} is too short to mean anything`).toBeGreaterThan(40)
    }
  })
})
