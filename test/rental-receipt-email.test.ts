import { describe, expect, it } from 'vitest'

import { bookingPaymentSummary, rentalChargedEmail } from '@/lib/email'

// What a provider is told when their card is charged, and what Keoni is told about the booking.
//
// The figure is the whole point of both messages, and getting it wrong is not a crash. It is a
// provider who believes a session was free, or an owner who believes one was not billed — and
// both of those happened before these tests existed: the appointments list showed $0.00 for a
// $60 charge because it rendered the client's price, and the desk email said "NO FEE RECORDED"
// on every successful booking because nobody passed it the amount.
//
// `bookingPaymentSummary` is the sentence both emails share, so that one phrase can never
// describe the same booking two different ways. Its four rental states are four different facts
// and only one of them is a problem, which is exactly why they must not collapse into each other.

const RENTAL = { paymentSource: 'rental', externalMethod: null, price: '0.00' }

describe('the one sentence about money', () => {
  it('names the amount when the card was charged', () => {
    const line = bookingPaymentSummary({ ...RENTAL, rentCents: 6000, paidFromPack: false })
    expect(line).toContain('$60.00')
    expect(line).toMatch(/charged to the provider/i)
  })

  it('says a credited session cost nothing, rather than reporting zero', () => {
    // "$0.00 charged" and "covered by a credit" are the same number and completely different
    // facts. Only one of them means somebody should look into it.
    const line = bookingPaymentSummary({ ...RENTAL, rentCents: null, paidFromPack: true })
    expect(line).toMatch(/credited session/i)
    expect(line).not.toMatch(/NO FEE/i)
  })

  it('distinguishes a refund from a session that was never billed', () => {
    const refunded = bookingPaymentSummary({ ...RENTAL, rentCents: 0, paidFromPack: false })
    // `rentPastDue` is what makes a missing row an alarm rather than a session whose twelve
    // hours have not elapsed. Before rent moved to after the session there was no such state.
    const never = bookingPaymentSummary({
      ...RENTAL,
      rentCents: null,
      paidFromPack: false,
      rentPastDue: true,
    })

    expect(refunded).toMatch(/refunded/i)
    expect(refunded).not.toMatch(/NO FEE/i)
    // The alarm. A rental booking past its grace period with no fee row, nobody having waived
    // it and no decision pending, is the only one of these that means something is broken.
    expect(never).toMatch(/NO FEE RECORDED/)
  })

  it('still describes a booking made before the rental model', () => {
    // Pre-cutover bookings keep their client price and their own sentence for months.
    const line = bookingPaymentSummary({
      paymentSource: 'external',
      externalMethod: 'groupon',
      price: '40.00',
    })
    expect(line).toContain('$40.00')
    expect(line).toMatch(/groupon/i)
  })
})

describe("the provider's receipt", () => {
  const BASE = {
    firstName: 'Nichole',
    serviceName: 'Laser Hair Removal — Bikini',
    when: 'Monday, October 5 at 12:00 PM',
    charged: '$60.00',
    cardLast4: '4242',
    url: 'https://app.melanitesuite.com/app/charges',
  }

  it('leads the subject with the amount', () => {
    // On a phone lock screen this is all they read, and "what did that cost me" is the only
    // question the message exists to answer.
    expect(rentalChargedEmail(BASE).subject).toContain('$60.00')
  })

  it('names the card, so a statement line can be reconciled', () => {
    const mail = rentalChargedEmail(BASE)
    expect(mail.text).toContain('4242')
    expect(mail.html).toContain('4242')
  })

  it('reads sensibly when the card is somehow unknown', () => {
    const mail = rentalChargedEmail({ ...BASE, cardLast4: null })
    expect(mail.text).toContain('$60.00')
    // No dangling "ending " with nothing after it.
    expect(mail.text).not.toMatch(/ending\s*:/)
    expect(mail.text).not.toMatch(/ending\s*$/m)
  })

  it('never tells them to mark it a no-show', () => {
    // THE REVERSE OF WHAT THIS TEST USED TO ASSERT, and the reversal is the point.
    //
    // It was written when the fee was taken at booking, so this message sat in the inbox
    // waiting for the day a client did not turn up and told them how to get the money back.
    // Rent has been taken twelve hours AFTER the session since 9 October: by the time this
    // lands the appointment has happened, the provider has usually closed it out, and
    // `markNoShow` refuses anything that is not `upcoming`.
    //
    // So the old wording named an action the app actively rejects. Telling somebody to do
    // something impossible about their own money is worse than saying nothing.
    const mail = rentalChargedEmail(BASE)
    expect(mail.text).not.toMatch(/no-show/i)
    expect(mail.html).not.toMatch(/no-show/i)
    expect(mail.text).not.toMatch(/cancel it/i)
  })

  it('describes a session that has happened, not one that is booked', () => {
    // Same root cause. "Laser booked / You have booked the laser for X" was the heading on a
    // receipt that arrives half a day after the treatment is over.
    const mail = rentalChargedEmail(BASE)
    expect(mail.html).not.toMatch(/laser booked/i)
    expect(mail.text).not.toMatch(/you have booked/i)
    expect(mail.text).toMatch(/has been charged/i)
  })

  it('says what the fee is not', () => {
    // The single most likely misreading is that Melanite is taking a cut of their treatment.
    expect(rentalChargedEmail(BASE).text).toMatch(/what you charged your own client is yours/i)
  })

  it('tells the three whose figure it is', () => {
    // "We charged you $77.55" with no account of where that came from invites a query that is
    // already answerable: Keoni worked it out from the receipt they sent her.
    const theirs = rentalChargedEmail({ ...BASE, setByMelanite: true })
    expect(theirs.text).toMatch(/worked out by Keoni from the receipt/i)

    // And everybody else is told the opposite thing — that processing is in the number — so
    // neither group is reading a sentence about the other's arrangement.
    const schedule = rentalChargedEmail(BASE)
    expect(schedule.text).toMatch(/including card processing/i)
    expect(schedule.text).not.toMatch(/Keoni/i)
  })

  it('points at charges rather than earnings', () => {
    expect(rentalChargedEmail(BASE).html).toContain('/app/charges')
  })
})
