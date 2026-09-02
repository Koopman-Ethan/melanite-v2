import { describe, expect, it } from 'vitest'

import { toCollectCents } from '@/lib/db/queries/daily-digest'
import { denverTimeLabel, eveningDigestEmail, roomDateLabel } from '@/lib/email'
import { digestDayFor, previousDay } from '@/lib/validation'

// The evening digest, as far as it goes without a database.
//
// Three separate rules live here and they fail in different ways: which DAY a run reports on,
// WHO owes money on a given appointment, and what the message actually says. The first two are
// where a wrong answer is silent.

describe('which business day a run reports on', () => {
  // 8pm Denver is 02:00 UTC in summer and 03:00 UTC in winter, and the job is scheduled at
  // both. Exactly one of the two must resolve to the day that just ended.
  const CLOSE = 20

  it('summer: the 02:00 UTC run is 8pm Denver and reports that day', () => {
    expect(digestDayFor(new Date('2026-07-16T02:00:00Z'), CLOSE)).toBe('2026-07-15')
  })

  it('summer: the 03:00 UTC run is 9pm Denver and reports the same day, so it dedupes', () => {
    expect(digestDayFor(new Date('2026-07-16T03:00:00Z'), CLOSE)).toBe('2026-07-15')
  })

  it('winter: the 02:00 UTC run is only 7pm Denver, so it reports the PREVIOUS day', () => {
    // The suite has not closed yet. Reporting "today" here would send half a day of takings
    // and burn the idempotency key before the real run an hour later.
    expect(digestDayFor(new Date('2026-01-16T02:00:00Z'), CLOSE)).toBe('2026-01-14')
  })

  it('winter: the 03:00 UTC run is 8pm Denver and reports that day', () => {
    expect(digestDayFor(new Date('2026-01-16T03:00:00Z'), CLOSE)).toBe('2026-01-15')
  })

  it('a badly delayed run still reports the right day rather than losing the night', () => {
    // 1am Denver, hours after the schedule should have fired.
    expect(digestDayFor(new Date('2026-01-16T08:00:00Z'), CLOSE)).toBe('2026-01-15')
  })

  it('follows the configured closing time rather than a hardcoded 8pm', () => {
    // 19:00 Denver. Closing at 6pm the day is over; closing at 8pm it is not.
    const at = new Date('2026-07-16T01:00:00Z')
    expect(digestDayFor(at, 18)).toBe('2026-07-15')
    expect(digestDayFor(at, 20)).toBe('2026-07-14')
  })

  it('steps back across a month boundary', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
  })
})

describe('who is holding money that belongs to Melanite', () => {
  const base = {
    isHouse: false,
    reconciled: false,
    paymentSource: 'external',
    externalMethod: 'groupon',
    price: '200.00',
  }

  it('claims half of an unrecorded Groupon booking', () => {
    expect(toCollectCents(base, 0.5)).toBe(10000)
  })

  it('claims nothing once the payment has been recorded', () => {
    // Recording the payment IS the act of saying collected — there is no separate column.
    expect(toCollectCents({ ...base, reconciled: true }, 0.5)).toBe(0)
  })

  it('claims nothing on Cherry, where the debt runs the other way', () => {
    // Cherry pays MELANITE, which then owes the PROVIDER. Invoicing here would point a bill at
    // somebody who never touched the money.
    expect(toCollectCents({ ...base, externalMethod: 'cherry' }, 0.5)).toBe(0)
  })

  it('claims nothing on a card payment, a package or a prepaid balance', () => {
    expect(toCollectCents({ ...base, paymentSource: 'checkout_link' }, 0.5)).toBe(0)
    expect(toCollectCents({ ...base, paymentSource: 'package_redemption' }, 0.5)).toBe(0)
    expect(toCollectCents({ ...base, paymentSource: 'prepaid' }, 0.5)).toBe(0)
    expect(toCollectCents({ ...base, paymentSource: 'comped' }, 0.5)).toBe(0)
  })

  it('never invoices Melanite for its own appointment', () => {
    expect(toCollectCents({ ...base, isHouse: true }, 0.5)).toBe(0)
  })

  it('claims nothing when no method was recorded, rather than guessing a direction', () => {
    expect(toCollectCents({ ...base, externalMethod: null }, 0.5)).toBe(0)
  })

  it('takes the platform share, not the provider share, when the split is not even', () => {
    // The bug this guards against: melanite_cut is gross * (1 - providerSharePct). At the
    // default 0.500 the two are identical, so an inverted formula stays invisible until the
    // rate moves. `getOwedByProvider` currently has it the wrong way round.
    expect(toCollectCents(base, 0.6)).toBe(8000)
    expect(toCollectCents(base, 0.25)).toBe(15000)
  })
})

describe('what the email says', () => {
  const row = {
    when: '2:00 PM',
    clientName: 'Dana Cole',
    serviceName: 'Laser Hair Removal',
    providerName: 'Alex Rivera',
    paying: 'Paid by Groupon, collected by the provider',
    toCollect: '100.00',
    isHouse: false,
    status: 'completed',
  }

  const build = (over: Partial<Parameters<typeof eveningDigestEmail>[0]> = {}) =>
    eveningDigestEmail({
      dayLabel: 'Tuesday, September 1',
      rows: [row],
      cancelled: 0,
      grossTotal: '200.00',
      toCollectTotal: '100.00',
      toCollectCount: 1,
      url: 'https://app.melanitesuite.com/app/admin/revenue',
      ...over,
    })

  it('leads the subject with what has to be done', () => {
    expect(build().subject).toBe('1 to collect ($100.00) · Tuesday, September 1')
  })

  it('says so plainly when there is nothing to chase', () => {
    expect(build({ rows: [], toCollectTotal: '0.00', toCollectCount: 0 }).subject).toBe(
      'No appointments · Tuesday, September 1',
    )

    const quiet = build({
      rows: [{ ...row, toCollect: null }],
      toCollectTotal: '0.00',
      toCollectCount: 0,
    })
    expect(quiet.subject).toBe('Nothing to collect · 1 appointment · Tuesday, September 1')
  })

  it('still sends on an empty evening, so silence means the job is broken', () => {
    const empty = build({ rows: [], toCollectTotal: '0.00', toCollectCount: 0 })
    expect(empty.text).toContain('Nothing to chase')
    expect(empty.html).toContain('Nothing to chase')
  })

  it('names everybody in both the html and the plain text', () => {
    const mail = build()
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain('Dana Cole')
      expect(body).toContain('Alex Rivera')
      expect(body).toContain('Laser Hair Removal')
    }
  })

  it('escapes a name that would otherwise break the html', () => {
    const mail = build({ rows: [{ ...row, clientName: 'Smith & Jones <VIP>' }] })
    expect(mail.html).toContain('Smith &amp; Jones &lt;VIP&gt;')
    expect(mail.html).not.toContain('<VIP>')
    // The plain text is not escaped, and should not be.
    expect(mail.text).toContain('Smith & Jones <VIP>')
  })

  it('flags an appointment nobody closed out', () => {
    const mail = build({ rows: [{ ...row, status: 'upcoming' }] })
    expect(mail.text).toContain('Still marked upcoming')
  })

  it('marks a house appointment rather than hiding it', () => {
    const mail = build({ rows: [{ ...row, isHouse: true, toCollect: null }] })
    expect(mail.text).toContain('(Melanite)')
  })

  it('acknowledges cancellations instead of silently dropping them', () => {
    const mail = build({ cancelled: 2 })
    expect(mail.text).toContain('2 cancelled, not listed.')
    expect(mail.html).toContain('2 cancelled, not listed.')
  })
})

describe('the labels the digest is built from', () => {
  it('names the day without drifting a day west', () => {
    expect(roomDateLabel('2026-09-01')).toBe('Tuesday, September 1')
  })

  it('renders a time in Denver, never the server zone', () => {
    // 20:00 UTC is 2:00 PM in Denver in September.
    expect(denverTimeLabel(new Date('2026-09-01T20:00:00Z'))).toBe('2:00 PM')
  })
})
