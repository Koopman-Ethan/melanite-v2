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
    expect(RENTAL_TERMS_VERSION).toBe('2026-10-02.v1')
  })

  it('sorts after an earlier version', () => {
    // Date-stamped so two versions can be compared as strings, the same as END_OF_USE_VERSION.
    expect(RENTAL_TERMS_VERSION > '2026-09-01.v1').toBe(true)
  })
})

describe('whether somebody has accepted', () => {
  it('accepts the current version', () => {
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: RENTAL_TERMS_VERSION })).toBe(true)
  })

  it('refuses an older one', () => {
    // The whole reason the version is stored rather than just a timestamp. Someone who accepted
    // last year's fee schedule has not agreed to this one.
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: '2026-01-01.v1' })).toBe(false)
  })

  it('refuses somebody who has never accepted', () => {
    expect(hasAcceptedRentalTerms({ rentalTermsVersion: null })).toBe(false)
    expect(hasAcceptedRentalTerms(null)).toBe(false)
    expect(hasAcceptedRentalTerms(undefined)).toBe(false)
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
    //   no_show_refund       releaseRentalForBooking, from markNoShow and cancelBooking
    //   packs                claimPackSession, oldest first
    //   fee_changes          hasAcceptedRentalTerms gates createBooking
    const keys = RENTAL_TERMS.map((t) => t.key)
    for (const required of [
      'fee_per_session',
      'decline_no_booking',
      'no_show_refund',
      'packs',
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
