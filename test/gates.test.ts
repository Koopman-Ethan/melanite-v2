import { describe, expect, it } from 'vitest'

import {
  bookingBlockedReasons,
  canBook,
  hasCurrentLicense,
  isLicenseExpired,
} from '@/lib/auth/dal'
import type { SessionUser } from '@/lib/auth/session'

// The booking gates.
//
// Three independent conditions, all of which must pass. v1 enforced them in three different
// places — two in page JavaScript, one inside the create endpoint — which is how the license
// check came to be the one everybody forgot. Tested here as a single answerable question.

const base: SessionUser = {
  id: 'p1',
  email: 'p@example.com',
  firstName: 'Test',
  lastName: 'Provider',
  role: 'provider',
  status: 'active',
  bookingEnabled: true,
  roomRentalEnabled: true,
  medicalDirectorStatus: 'active',
  // A licence on file and in date. It used to be null here, and the suite still passed —
  // because a null expiry cleared the licence gate rather than closing it. A fixture that
  // silently exercised the hole is part of why it survived this long.
  licenseExpiry: '2099-12-31',
  requiresPasswordReset: false,
  // Not a booking gate — the equipment policy is asked for before taking NEW laser time, and
  // deliberately does not join the three clinical gates. Set here so the fixture is a complete
  // SessionUser, not because canBook looks at it.
  equipmentPolicyAckVersion: null,
}

const user = (overrides: Partial<SessionUser> = {}): SessionUser => ({ ...base, ...overrides })

describe('canBook', () => {
  it('allows a provider who passes all three gates', () => {
    expect(canBook(user())).toBe(true)
  })

  it('blocks when booking is not enabled', () => {
    expect(canBook(user({ bookingEnabled: false }))).toBe(false)
  })

  it.each(['none', 'past_due', 'inactive'] as const)(
    'blocks when medical director status is %s',
    (status) => {
      expect(canBook(user({ medicalDirectorStatus: status }))).toBe(false)
    },
  )

  it('blocks on an expired license even when everything else passes', () => {
    // The gate v1 kept forgetting.
    expect(canBook(user({ licenseExpiry: '2020-01-01' }))).toBe(false)
  })

  it('blocks when there is no license on file at all', () => {
    // This asserted the opposite until 2026-08-24, and was correct about the code at the time:
    // the gate was `!isLicenseExpired`, and a null expiry is not an expired one. So a provider
    // with no licence recorded passed the licence check outright — which nobody noticed while
    // every bookable provider happened to have one.
    expect(canBook(user({ licenseExpiry: null }))).toBe(false)
  })
})

describe('hasCurrentLicense', () => {
  it('wants a licence that is both on file AND in date', () => {
    expect(hasCurrentLicense(user({ licenseExpiry: '2099-12-31' }))).toBe(true)
    expect(hasCurrentLicense(user({ licenseExpiry: '2020-01-01' }))).toBe(false)
    expect(hasCurrentLicense(user({ licenseExpiry: null }))).toBe(false)
  })

  it('still counts a licence expiring soon as current', () => {
    // 'expiring' is a warning state for the account page and the roster, not a gate. Somebody
    // with three weeks left can still work.
    const soon = new Date()
    soon.setDate(soon.getDate() + 21)
    expect(hasCurrentLicense(user({ licenseExpiry: soon.toISOString().slice(0, 10) }))).toBe(true)
  })
})

describe('isLicenseExpired', () => {
  it('treats a far-future expiry as valid', () => {
    expect(isLicenseExpired(user({ licenseExpiry: '2099-12-31' }))).toBe(false)
  })

  it('treats a past expiry as expired', () => {
    expect(isLicenseExpired(user({ licenseExpiry: '2020-06-30' }))).toBe(true)
  })

  it('compares as a calendar date, not an instant', () => {
    // A license valid "through today" must not expire because the server is ahead of Denver in
    // UTC. Today in Denver is still today.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
      new Date(),
    )
    expect(isLicenseExpired(user({ licenseExpiry: today }))).toBe(false)
  })
})

describe('bookingBlockedReasons', () => {
  it('is empty when nothing is blocking', () => {
    expect(bookingBlockedReasons(user())).toEqual([])
  })

  it('returns EVERY failing gate, not just the first', () => {
    // The behaviour change from v1, which threw on the first precondition and so turned one
    // onboarding problem into three separate support messages.
    const reasons = bookingBlockedReasons(
      user({
        bookingEnabled: false,
        medicalDirectorStatus: 'none',
        licenseExpiry: '2020-01-01',
      }),
    )

    expect(reasons.map((r) => r.gate).sort()).toEqual([
      'booking_enabled',
      'license',
      'medical_director',
    ])
  })

  it('offers a self-serve route only where one exists', () => {
    const [mdGate] = bookingBlockedReasons(user({ medicalDirectorStatus: 'past_due' }))
    expect(mdGate.href).toBeTruthy()

    // Documents and license renewal both go through Melanite, so offering a link would be a
    // dead end dressed up as an action.
    const [docGate] = bookingBlockedReasons(user({ bookingEnabled: false }))
    expect(docGate.href).toBeUndefined()

    // The licence DOES have one: the number and expiry are entered on the account page, so
    // sending them there is a real action rather than a dead end dressed up as one.
    const [licenseGate] = bookingBlockedReasons(user({ licenseExpiry: '2020-01-01' }))
    expect(licenseGate.href).toBe('/app/account')
  })

  it('says something different for a missing licence than for an expired one', () => {
    // "Renew it" is useless advice to somebody who never recorded one in the first place.
    const [missing] = bookingBlockedReasons(user({ licenseExpiry: null }))
    const [expired] = bookingBlockedReasons(user({ licenseExpiry: '2020-01-01' }))

    expect(missing.message).not.toBe(expired.message)
    expect(missing.message).toMatch(/no professional license/i)
    expect(expired.message).toMatch(/expired/i)
    expect(missing.action).not.toBe(expired.action)
  })

  it('says something different for past_due than for none', () => {
    const [pastDue] = bookingBlockedReasons(user({ medicalDirectorStatus: 'past_due' }))
    const [none] = bookingBlockedReasons(user({ medicalDirectorStatus: 'none' }))
    expect(pastDue.message).not.toBe(none.message)
  })
})
