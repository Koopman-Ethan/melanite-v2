import { describe, expect, it } from 'vitest'

import {
  LICENSE_WARNING_DAYS,
  denverToday,
  licenseMessage,
  licenseStatus,
  licenseUrgency,
} from '@/lib/license'

// Dates are where this app has been wrong before — an Intl call that dropped the month, a
// license gate that read UTC. So the boundaries get pinned down rather than assumed.

/** Noon UTC on a fixed day, which is 6am in Denver — safely inside the same calendar date
 *  either side of a DST change. */
const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('denverToday', () => {
  it('is the Denver calendar date, not the UTC one', () => {
    // 01:00 UTC on the 15th is still 18:00 on the 14th in Denver. A gate comparing against the
    // UTC date would expire a license most of a day early.
    expect(denverToday(new Date('2026-07-15T01:00:00Z'))).toBe('2026-07-14')
  })

  it('holds across a DST boundary', () => {
    // MDT (-6) in July, MST (-7) in January. Both must still land on the local date.
    expect(denverToday(new Date('2026-07-15T05:00:00Z'))).toBe('2026-07-14')
    expect(denverToday(new Date('2026-01-15T06:00:00Z'))).toBe('2026-01-14')
  })
})

describe('licenseStatus', () => {
  it('reports a missing date as its own state', () => {
    // Not folded into 'ok'. The booking gate tolerates a null so imported rows are not locked
    // out; this is the surface whose entire job is to say so out loud.
    expect(licenseStatus(null).state).toBe('missing')
    expect(licenseStatus(undefined).state).toBe('missing')
    expect(licenseStatus('').state).toBe('missing')
    expect(licenseStatus(null).daysLeft).toBeNull()
  })

  it('is ok well ahead of the window', () => {
    const status = licenseStatus('2027-01-01', at('2026-07-27'))
    expect(status.state).toBe('ok')
    expect(status.daysLeft).toBe(158)
  })

  it('starts warning exactly at the boundary, not a day late', () => {
    // 60 days out warns; 61 does not. Off-by-one here is a provider who never gets told.
    const now = at('2026-07-27')
    expect(licenseStatus('2026-09-25', now).state).toBe('expiring') // 60 days
    expect(licenseStatus('2026-09-26', now).state).toBe('ok') // 61 days
    expect(LICENSE_WARNING_DAYS).toBe(60)
  })

  it('treats the expiry day itself as still valid', () => {
    // A license valid "through the 22nd" works on the 22nd. Booking stops on the 23rd.
    const status = licenseStatus('2026-07-27', at('2026-07-27'))
    expect(status.state).toBe('expiring')
    expect(status.daysLeft).toBe(0)
  })

  it('is expired the day after', () => {
    const status = licenseStatus('2026-07-26', at('2026-07-27'))
    expect(status.state).toBe('expired')
    expect(status.daysLeft).toBe(-1)
  })

  it('counts days exactly across a DST change', () => {
    // Denver loses an hour on 2026-03-08. Measured in hours, this span is 59.958 days and would
    // round to 59 — inside the window when it should be outside it.
    expect(licenseStatus('2026-04-15', at('2026-02-14')).daysLeft).toBe(60)
    expect(licenseStatus('2026-03-09', at('2026-03-07')).daysLeft).toBe(2)
  })

  it("matches the real provider whose license is closest to lapsing", () => {
    // bmayesthetics@gmail.com, the row that prompted all of this.
    const status = licenseStatus('2026-09-22', at('2026-07-27'))
    expect(status.state).toBe('expiring')
    expect(status.daysLeft).toBe(57)
  })
})

describe('licenseMessage', () => {
  it('says nothing when there is nothing to say', () => {
    expect(licenseMessage(licenseStatus('2027-01-01', at('2026-07-27')), '2027-01-01')).toBeNull()
  })

  it('uses singular for one day', () => {
    const status = licenseStatus('2026-07-28', at('2026-07-27'))
    expect(licenseMessage(status, '2026-07-28')).toContain('1 day,')
  })

  it('has a distinct wording for the last day', () => {
    const status = licenseStatus('2026-07-27', at('2026-07-27'))
    expect(licenseMessage(status, '2026-07-27')).toContain('expires today')
  })

  it('tells someone with no date on file what to do', () => {
    expect(licenseMessage(licenseStatus(null), null)).toContain('no license expiry date')
  })
})

describe('licenseUrgency', () => {
  it('sorts the most urgent first, with missing dates at the very top', () => {
    const now = at('2026-07-27')
    const rows = [
      { name: 'fine', status: licenseStatus('2027-06-01', now) },
      { name: 'missing', status: licenseStatus(null, now) },
      { name: 'expired', status: licenseStatus('2026-01-01', now) },
      { name: 'soon', status: licenseStatus('2026-08-10', now) },
    ]
    const order = rows
      .sort((a, b) => licenseUrgency(a.status) - licenseUrgency(b.status))
      .map((r) => r.name)

    // Missing above expired on purpose: an absent date is the one nobody is tracking at all.
    expect(order).toEqual(['missing', 'expired', 'soon', 'fine'])
  })
})
