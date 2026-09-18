import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MELANITE_NOTIFY_EMAIL,
  bookingPaymentSummary,
  deskBookingEmail,
  deskCloseoutEmail,
  deskPaymentReceivedEmail,
  deskRoomRentalEmail,
  roomDateLabel,
} from '@/lib/email'

// What Melanite is told when the calendar changes.
//
// These are the only emails addressed to the business rather than to a client or a provider, and
// the one thing they exist to carry is "the laser is taken, by whom, and is there money to
// chase". The payment line is where being wrong is expensive and silent: a Groupon booking is
// money the PROVIDER collected and Melanite has to invoice back, and describing it as a payment
// link would tell Keoni to expect money that is never going to arrive on its own.

const BOOKING = {
  event: 'booked' as const,
  clientName: 'Alex Rivera',
  providerName: 'Dana Cole',
  serviceName: 'Laser Hair Removal — Brazilian',
  when: 'Thursday, August 20 at 2:00 PM',
  durationMins: 30,
  paying: '$180.00 due on a payment link',
  url: 'https://app.melanitesuite.com/app/admin/calendar',
}

describe('the payment line', () => {
  it('calls a Groupon booking money the provider is holding', () => {
    const line = bookingPaymentSummary({
      paymentSource: 'external',
      externalMethod: 'groupon',
      price: '180.00',
    })

    expect(line).toContain('$180.00')
    expect(line).toContain('Groupon')
    // The half Melanite never receives is the reason this booking needs a figure at all.
    expect(line).toContain('invoice')
  })

  it('points a Cherry booking the other way, because Cherry pays Melanite', () => {
    // The one external method where the money moves toward Melanite. Telling Keoni to invoice
    // the provider for a Cherry booking points a bill at somebody who never touched the money.
    const line = bookingPaymentSummary({
      paymentSource: 'external',
      externalMethod: 'cherry',
      price: '600.00',
    })

    expect(line).toContain('Cherry')
    expect(line).toContain('still owed')
    expect(line).not.toContain('collected by the provider')
    expect(line).not.toContain('invoice')
  })

  it('claims no direction for a method it does not recognise', () => {
    // `external_method` is nullable, and an imported v1 row can carry a value this list has
    // never heard of. Neither may produce "paid by , collected by the provider" — nor a guess
    // about who owes whom.
    for (const externalMethod of [null, 'venmo']) {
      const line = bookingPaymentSummary({
        paymentSource: 'external',
        externalMethod,
        price: '90.00',
      })

      expect(line).toContain('an external method')
      expect(line).toContain('outside Melanite')
      expect(line).not.toContain('invoice')
      expect(line).not.toContain('still owed')
    }
  })

  it('says there is nothing to collect on a package session', () => {
    const line = bookingPaymentSummary({
      paymentSource: 'package_redemption',
      externalMethod: null,
      price: '0.00',
    })

    expect(line).toContain('nothing to collect')
    // A redemption's price is zero and always will be. "$0.00" here reads as a free treatment.
    expect(line).not.toContain('$0.00')
  })

  it('distinguishes a fully covered prepaid booking from one with a remainder', () => {
    const covered = bookingPaymentSummary({
      paymentSource: 'prepaid',
      externalMethod: null,
      price: '0.00',
    })
    const partial = bookingPaymentSummary({
      paymentSource: 'prepaid',
      externalMethod: null,
      price: '40.00',
    })

    expect(covered).toContain('nothing to collect')
    expect(partial).toContain('$40.00')
    expect(partial).toContain('still due')
  })

  it('says a comped appointment is comped', () => {
    expect(
      bookingPaymentSummary({ paymentSource: 'comped', externalMethod: null, price: '0.00' }),
    ).toContain('Comped')
  })

  it('formats the money column, which is a string', () => {
    // `money()` columns come back as '180.5', not a Number. Concatenating one straight into the
    // sentence would print "$180.5".
    expect(
      bookingPaymentSummary({
        paymentSource: 'checkout_link',
        externalMethod: null,
        price: '180.5',
      }),
    ).toContain('$180.50')
  })
})

describe('the appointment alert', () => {
  it('says what and when in the subject, which is all a phone shows', () => {
    expect(deskBookingEmail(BOOKING).subject).toBe(
      'Booked: Laser Hair Removal — Brazilian — Thursday, August 20 at 2:00 PM',
    )
    expect(deskBookingEmail({ ...BOOKING, event: 'cancelled' }).subject).toBe(
      'Cancelled: Laser Hair Removal — Brazilian — Thursday, August 20 at 2:00 PM',
    )
  })

  it('carries the client, the provider, the duration and the payment line', () => {
    const mail = deskBookingEmail(BOOKING)

    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('Alex Rivera')
      expect(part).toContain('Dana Cole')
      expect(part).toContain('30 minutes')
      expect(part).toContain('$180.00 due on a payment link')
    }
  })

  it('reads as a cancellation, not a booking, when it is one', () => {
    const mail = deskBookingEmail({ ...BOOKING, event: 'cancelled' })

    expect(mail.text).toContain('has been cancelled')
    expect(mail.text).not.toContain('has been booked')
    expect(mail.html).toContain('Appointment cancelled')
  })

  it('links to the calendar', () => {
    const mail = deskBookingEmail(BOOKING)
    expect(mail.text).toContain('https://app.melanitesuite.com/app/admin/calendar')
    expect(mail.html).toContain('https://app.melanitesuite.com/app/admin/calendar')
  })
})

const RENTAL = {
  event: 'booked' as const,
  providerName: 'Nichole Vance',
  slotLabel: 'Full day',
  dateLabel: 'Friday, August 21',
  price: '100.00',
  url: 'https://app.melanitesuite.com/app/admin/calendar',
}

describe('the room alert', () => {
  it('names the block and the day in the subject', () => {
    expect(deskRoomRentalEmail(RENTAL).subject).toBe('Room booked: Full day, Friday, August 21')
    expect(deskRoomRentalEmail({ ...RENTAL, event: 'cancelled' }).subject).toBe(
      'Room cancelled: Full day, Friday, August 21',
    )
  })

  it('says when the refund is Keoni’s decision', () => {
    // A cancellation inside 24 hours parks the rental in the admin queue. The alert is the only
    // thing that tells her to go and look.
    const mail = deskRoomRentalEmail({
      ...RENTAL,
      event: 'cancelled',
      awaitingRefundDecision: true,
    })

    expect(mail.text).toContain('inside 24 hours')
    expect(mail.text).toContain('admin queue')
    expect(mail.html).toContain('admin queue')
  })

  it('says nothing about a refund decision when there is none to make', () => {
    const mail = deskRoomRentalEmail({ ...RENTAL, event: 'cancelled' })
    expect(mail.text).not.toContain('admin queue')
    expect(mail.html).not.toContain('admin queue')
  })
})

describe('the payment-received alert', () => {
  const paid = {
    kind: 'booking' as const,
    clientName: 'halah',
    providerName: 'Nichole Mim',
    what: 'Sunspot Removal',
    when: 'Monday, September 7 at 11:15 AM',
    charged: '$95.00',
    tip: null as string | null,
    isHouse: false,
    url: 'https://app.melanitesuite.com/app/admin/revenue',
  }

  it('leads the subject with the amount', () => {
    // What she is scanning for, and most of what a phone lock screen shows.
    expect(deskPaymentReceivedEmail(paid).subject).toBe(
      'Paid: $95.00 — Sunspot Removal, Nichole Mim',
    )
  })

  it('names who paid, what for, and which provider', () => {
    const mail = deskPaymentReceivedEmail(paid)
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('halah')
      expect(part).toContain('$95.00')
      expect(part).toContain('Sunspot Removal')
      expect(part).toContain('Nichole Mim')
      expect(part).toContain('Monday, September 7 at 11:15 AM')
    }
  })

  it('NEVER states anybody’s share', () => {
    // The decision most likely to be undone by accident later. Keoni was asked whether she wanted
    // the split and said she can work out her own cut; the provider's version of this email says
    // "Your share", and copying that across is the obvious wrong turn.
    for (const kind of ['booking', 'package', 'prepaid'] as const) {
      const mail = deskPaymentReceivedEmail({ ...paid, kind, tip: '$20.00' })
      for (const part of [mail.text, mail.html]) {
        expect(part).not.toContain('share')
        expect(part).not.toContain('payout')
        expect(part).not.toContain('Melanite keeps')
      }
    }
  })

  it('mentions a tip only when there was one', () => {
    expect(deskPaymentReceivedEmail({ ...paid, tip: '$20.00' }).text).toContain(
      'Includes a $20.00 tip.',
    )
    // An explicit "$0.00 tip" reads as a complaint — the same rule providerPaidEmail follows.
    const none = deskPaymentReceivedEmail(paid)
    expect(none.text.toLowerCase()).not.toContain('tip')
    expect(none.html.toLowerCase()).not.toContain('tip')
  })

  it('says when the money is Melanite’s own', () => {
    // House appointments are included on purpose. The provider's copy suppresses them because
    // "your share is nothing" is meaningless; here the whole amount is hers.
    const mail = deskPaymentReceivedEmail({ ...paid, isHouse: true })
    expect(mail.text).toContain("Melanite's own")
    expect(mail.html).toContain('Melanite')
  })

  it('reads correctly for a package, which has no date', () => {
    const mail = deskPaymentReceivedEmail({
      ...paid,
      kind: 'package',
      what: 'Glow Package',
      when: null,
      charged: '$600.00',
    })
    expect(mail.subject).toBe('Paid: $600.00 — Glow Package, Nichole Mim')
    expect(mail.text).toContain('has paid $600.00 for Glow Package')
    // No empty gap where the appointment time would be.
    expect(mail.text).not.toContain('\n\n\n')
    expect(mail.html).not.toContain('<br></p>')
  })

  it('says "onto" a prepaid balance rather than "for" one', () => {
    // "paid $200.00 for a prepaid balance" reads as buying a thing; the money IS the balance.
    const mail = deskPaymentReceivedEmail({
      ...paid,
      kind: 'prepaid',
      what: 'a prepaid balance',
      when: null,
      charged: '$200.00',
    })
    expect(mail.text).toContain('has paid $200.00 onto a prepaid balance')
    expect(mail.text).not.toContain('for a prepaid balance')
  })

  it('escapes names, which come from a client typing into a checkout page', () => {
    const mail = deskPaymentReceivedEmail({ ...paid, clientName: 'a<script>b' })
    expect(mail.html).toContain('&lt;script&gt;')
    expect(mail.html).not.toContain('<script>')
  })

  it('links to the revenue page', () => {
    const mail = deskPaymentReceivedEmail(paid)
    expect(mail.text).toContain('https://app.melanitesuite.com/app/admin/revenue')
    expect(mail.html).toContain('https://app.melanitesuite.com/app/admin/revenue')
  })
})

describe('the close-out alert', () => {
  const base = {
    providerName: 'Nichole Mim',
    serviceName: 'Carbon Laser Treatment',
    when: 'Monday 14 September, 2:00pm',
    deviceIssue: false,
    deviceIssueNote: null,
    cameUpLabels: [],
    note: null,
    url: 'https://app.melanitesuite.com/app/admin/equipment',
  }

  it('states the nothing, rather than rendering an empty body', () => {
    // Reachable when a provider leaves a note with no fault attached — the action stopped sending
    // on genuinely silent close-outs, but this shape still goes out. An email whose body is empty
    // reads as one that failed to load, so the nothing is said out loud.
    const out = deskCloseoutEmail(base)
    expect(out.subject).toBe('Closed out — Nichole Mim, Monday 14 September, 2:00pm')
    expect(out.text).toContain(
      'Nichole Mim has closed out their Carbon Laser Treatment appointment from Monday 14 September, 2:00pm.',
    )
    expect(out.text).toContain(
      'All required checklist items were marked, and no issues were reported.',
    )
    expect(out.html).toContain('All required checklist items were marked, and no issues were reported.')
  })

  it('does not claim "no issues" when something was reported', () => {
    // The status sentence is two sentences in one, and the second half is only true on a quiet
    // session. Saying "no issues were reported" above a reported shortage is the kind of wrong
    // that makes somebody stop reading the rest.
    const out = deskCloseoutEmail({ ...base, cameUpLabels: ['Supply shortage reported'] })
    expect(out.text).toContain('All required checklist items were marked.')
    expect(out.text).not.toContain('no issues were reported')
  })

  it('puts a device fault in the SUBJECT, not just the body', () => {
    // The triage happens before the email is opened. A run of ordinary close-outs must never
    // bury the one that matters, and at one to three a day the subject line is the only thing
    // reliably read.
    const out = deskCloseoutEmail({
      ...base,
      deviceIssue: true,
      deviceIssueNote: 'Handpiece window is chipped',
    })
    expect(out.subject).toBe('Device issue — Nichole Mim, Monday 14 September, 2:00pm')
    expect(out.text).toContain('Handpiece window is chipped')
    expect(out.text).not.toContain('no issues were reported')
  })

  it('points at the photograph the report had to carry', () => {
    // A fault could once arrive twice — flagged on an arrival photo AND described here — and this
    // said so to stop one incident reading as two. The arrival photos are gone: there is one
    // report, it carries its own picture, and the email says where to look at it.
    const out = deskCloseoutEmail({
      ...base,
      deviceIssue: true,
      deviceIssueNote: 'Cracked',
    })
    expect(out.text).toContain('A photo of it is on the close-out.')
    expect(out.html).toContain('A photo of it is on the close-out.')
  })

  it('reports conditional items as findings, not as instructions', () => {
    // The labels are checklist imperatives — "Notify management of any supply shortages". Printed
    // back as a finding that reads as a reminder to whoever opened the email, which is what the
    // first version of this actually did: "Also noted: Save before-and-after photos (if
    // applicable)".
    const out = deskCloseoutEmail({ ...base, cameUpLabels: ['Supply shortage reported'] })
    expect(out.text).toContain('Supply shortage reported')
    expect(out.text).not.toContain('Notify management')
    expect(out.text).not.toContain('(if applicable)')
    // Still an ordinary close-out — a shortage is not a device fault.
    expect(out.subject).toContain('Closed out')
  })

  it('escapes what a provider typed', () => {
    // The note and the fault description are free text straight from a phone.
    const out = deskCloseoutEmail({
      ...base,
      note: 'gel <b>everywhere</b>',
    })
    expect(out.html).toContain('&lt;b&gt;')
    expect(out.html).not.toContain('<b>everywhere</b>')
  })
})

describe('roomDateLabel', () => {
  it('reads a date column as the day it says', () => {
    // `rental_date` is a bare date. Parsed as local midnight it lands on the day before for any
    // server west of UTC, which is every server this app runs on.
    expect(roomDateLabel('2026-08-21')).toBe('Friday, August 21')
    expect(roomDateLabel('2026-01-01')).toBe('Thursday, January 1')
  })
})

describe('the recipient', () => {
  const original = process.env.MELANITE_NOTIFY_EMAIL

  afterEach(() => {
    if (original === undefined) delete process.env.MELANITE_NOTIFY_EMAIL
    else process.env.MELANITE_NOTIFY_EMAIL = original
    vi.resetModules()
  })

  it('defaults to Melanite’s own inbox with nothing configured', () => {
    // The default is in code precisely so that an unset variable cannot switch the alerts off.
    expect(MELANITE_NOTIFY_EMAIL).toBe('melanitelasersuite@gmail.com')
  })

  it('honours an override', async () => {
    process.env.MELANITE_NOTIFY_EMAIL = 'someone.else@example.com'
    // Read once at import time, so the module has to be re-evaluated for this to be visible.
    vi.resetModules()
    const fresh = await import('@/lib/email')
    expect(fresh.MELANITE_NOTIFY_EMAIL).toBe('someone.else@example.com')
  })
})
