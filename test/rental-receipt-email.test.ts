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
    const never = bookingPaymentSummary({ ...RENTAL, rentCents: null, paidFromPack: false })

    expect(refunded).toMatch(/refunded/i)
    expect(refunded).not.toMatch(/NO FEE/i)
    // The alarm. A rental booking with no fee row at all is the crash window from the booking
    // path, and it is the only one of these four that means something is broken.
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

  it('says the money comes back on a no-show', () => {
    // A refund nobody knows about is a refund nobody claims, and this is the message still in
    // their inbox on the day the client does not turn up.
    const mail = rentalChargedEmail(BASE)
    expect(mail.text).toMatch(/no-show/i)
    expect(mail.html).toMatch(/no-show/i)
  })

  it('says what the fee is not', () => {
    // The single most likely misreading is that Melanite is taking a cut of their treatment.
    expect(rentalChargedEmail(BASE).text).toMatch(/what you charge your client is yours/i)
  })

  it('points at charges rather than earnings', () => {
    expect(rentalChargedEmail(BASE).html).toContain('/app/charges')
  })
})
