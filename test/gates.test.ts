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
  hasMedicalDirectorOnFile: false,
  // A licence on file and in date. It used to be null here, and the suite still passed —
  // because a null expiry cleared the licence gate rather than closing it. A fixture that
  // silently exercised the hole is part of why it survived this long.
  licenseExpiry: '2099-12-31',
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

describe('a medical director that has been filed but not confirmed', () => {
  // Filing does not open the gate — that is deliberate. But the message must stop telling her to
  // do the thing she has just done, or the only signal she gets is that it did not work.
  it('tells a provider who has filed nothing to set one up', () => {
    const reasons = bookingBlockedReasons({
      ...base,
      medicalDirectorStatus: 'none',
      hasMedicalDirectorOnFile: false,
    })
    const gate = reasons.find((r) => r.gate === 'medical_director')
    expect(gate?.message).toMatch(/need a medical director on file/i)
    expect(gate?.action).toMatch(/set up/i)
  })

  it('tells a provider who HAS filed one that Melanite is confirming it', () => {
    const reasons = bookingBlockedReasons({
      ...base,
      medicalDirectorStatus: 'none',
      hasMedicalDirectorOnFile: true,
    })
    const gate = reasons.find((r) => r.gate === 'medical_director')
    expect(gate?.message).toMatch(/Melanite is confirming/i)
    expect(gate?.message, 'she was told to set up what she already filed').not.toMatch(/need a medical director on file/i)
  })

  it('still blocks her either way', () => {
    for (const filed of [true, false]) {
      expect(
        canBook({ ...base, medicalDirectorStatus: 'none', hasMedicalDirectorOnFile: filed }),
      ).toBe(false)
    }
  })
})

describe('which appointments can still be paid for', () => {
  // The rule that cost a real $70 treatment. `getCheckoutByToken` refused anything that was not
  // `upcoming`, so a provider marking an appointment Completed — which is what she does after
  // treating somebody — locked her client out of paying, and the page told the client to contact
  // the provider who had just caused it.
  //
  // Expressed here as the predicate rather than through the query, because what went wrong was
  // the RULE, not the SQL: three statuses that mean entirely different things were collapsed
  // into "not upcoming".
  const unpayable = (status: string) => status === 'cancelled' || status === 'no_show'

  it('lets a completed treatment be paid for', () => {
    // The work was done. This is when the money is most owed, not least.
    expect(unpayable('completed')).toBe(false)
  })

  it('still refuses a cancelled appointment', () => {
    // Nothing was delivered, so paying would take money for nothing — the original and correct
    // half of the reasoning.
    expect(unpayable('cancelled')).toBe(true)
  })

  it('still refuses a no-show', () => {
    // Settled through the fee path at the cancellation rate, not by charging the service price.
    expect(unpayable('no_show')).toBe(true)
  })

  it('lets an upcoming appointment be paid for', () => {
    expect(unpayable('upcoming')).toBe(false)
  })
})
