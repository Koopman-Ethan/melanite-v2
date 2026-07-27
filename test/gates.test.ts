import { describe, expect, it } from 'vitest'

import { bookingBlockedReasons, canBook, isLicenseExpired } from '@/lib/auth/dal'
import type { SessionUser } from '@/lib/auth/session'

// The booking gates.
//
// Three independent conditions, all of which must pass. v1 enforced them in three different
// places — two in page JavaScript, one inside the create endpoint — which is how the licence
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
  licenseExpiry: null,
  requiresPasswordReset: false,
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

  it('blocks on an expired licence even when everything else passes', () => {
    // The gate v1 kept forgetting.
    expect(canBook(user({ licenseExpiry: '2020-01-01' }))).toBe(false)
  })

  it('allows a licence with no expiry on file', () => {
    expect(canBook(user({ licenseExpiry: null }))).toBe(true)
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
    // A licence valid "through today" must not expire because the server is ahead of Denver in
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

    // Documents and licence renewal both go through Melanite, so offering a link would be a
    // dead end dressed up as an action.
    const [docGate] = bookingBlockedReasons(user({ bookingEnabled: false }))
    expect(docGate.href).toBeUndefined()

    const [licenceGate] = bookingBlockedReasons(user({ licenseExpiry: '2020-01-01' }))
    expect(licenceGate.href).toBeUndefined()
  })

  it('says something different for past_due than for none', () => {
    const [pastDue] = bookingBlockedReasons(user({ medicalDirectorStatus: 'past_due' }))
    const [none] = bookingBlockedReasons(user({ medicalDirectorStatus: 'none' }))
    expect(pastDue.message).not.toBe(none.message)
  })
})
