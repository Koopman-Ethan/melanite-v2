import { describe, expect, it } from 'vitest'

import { providerPaidEmail } from '@/lib/email'

// What a provider is told when one of their clients pays.
//
// The figures are the whole point of this message. A provider reads it to know what landed, and
// two different numbers are in play: what the client's card was charged, and what actually
// reaches the provider's bank after Melanite's cut. Quoting one where the other belongs is the
// failure mode worth a test — it is not a crash, it is a provider expecting money that is not
// coming, and they would only find out at payout.

const BASE = {
  firstName: 'Dana',
  clientName: 'Alex Rivera',
  what: 'Laser Hair Removal — Full Legs',
  when: 'Thursday, August 14 at 2:00 PM',
  charged: '$220.00',
  tip: '$20.00',
  payout: '$190.00',
  url: 'https://app.melanitesuite.com/app/earnings',
}

describe('the amounts', () => {
  it('shows both what the client paid and what the provider keeps', () => {
    const mail = providerPaidEmail(BASE)

    // Both, in both parts. A provider reconciling against "I paid $220" needs to find $220 here,
    // and still needs to see that $190 is theirs.
    expect(mail.text).toContain('$220.00')
    expect(mail.text).toContain('$190.00')
    expect(mail.html).toContain('$220.00')
    expect(mail.html).toContain('$190.00')
  })

  it('names the client and the amount in the subject', () => {
    // Read on a phone, from the notification shade, without opening anything.
    expect(providerPaidEmail(BASE).subject).toBe('Payment received — Alex Rivera paid $220.00')
  })

  it('says a tip is theirs in full', () => {
    const mail = providerPaidEmail(BASE)
    expect(mail.text).toContain('$20.00 tip, which is yours in full')
    expect(mail.html).toContain('yours in full')
  })

  it('says nothing at all when there was no tip', () => {
    // An explicit "$0.00 tip" line reads as a complaint about the client.
    const mail = providerPaidEmail({ ...BASE, tip: null })
    expect(mail.text).not.toContain('tip')
    expect(mail.html).not.toContain('tip')
  })
})

describe('what was bought', () => {
  it('carries the appointment time for a booking', () => {
    const mail = providerPaidEmail(BASE)
    expect(mail.text).toContain('Thursday, August 14 at 2:00 PM')
    expect(mail.html).toContain('Thursday, August 14 at 2:00 PM')
  })

  it('leaves no empty gap for a package, which has no date', () => {
    const mail = providerPaidEmail({
      ...BASE,
      what: '6-Session Laser Package',
      when: null,
    })

    expect(mail.text).toContain('6-Session Laser Package')
    // The line that would have held the date must not survive as a blank one.
    expect(mail.text).not.toMatch(/\n\n\n/)
    expect(mail.html).not.toContain('<br></p>')
  })
})

describe('addressing', () => {
  it('links to the earnings page', () => {
    const mail = providerPaidEmail(BASE)
    expect(mail.text).toContain('https://app.melanitesuite.com/app/earnings')
    expect(mail.html).toContain('https://app.melanitesuite.com/app/earnings')
  })

  it('greets the provider by their first name', () => {
    expect(providerPaidEmail(BASE).text).toContain('Hi Dana,')
  })
})
