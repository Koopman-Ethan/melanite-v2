import { describe, expect, it } from 'vitest'

import { addDays, minutesOf, weekStartOf } from '@/lib/db/queries/admin-calendar'
import { denverInstant } from '@/lib/db/queries/availability'

// Timezone handling.
//
// This is tested first because it is the failure mode that produces no error and no crash — an
// appointment simply happens at the wrong time, and nobody finds out until a client arrives to
// an empty room. Mountain Time is UTC-7 in summer and UTC-6 in winter, so any fixed offset is
// silently wrong for half the year.

describe('denverInstant', () => {
  it('resolves a summer time to UTC-6 (MDT)', () => {
    // 2026-07-15 is inside daylight saving. 10:00 Denver is 16:00 UTC.
    expect(denverInstant('2026-07-15', '10:00').toISOString()).toBe('2026-07-15T16:00:00.000Z')
  })

  it('resolves a winter time to UTC-7 (MST)', () => {
    // 2026-01-15 is standard time. The same wall clock is an hour later in UTC.
    expect(denverInstant('2026-01-15', '10:00').toISOString()).toBe('2026-01-15T17:00:00.000Z')
  })

  it('uses the offset in force on the date, not the offset today', () => {
    // The whole point: two dates six months apart, same wall clock, one hour of difference.
    const summer = denverInstant('2026-07-15', '14:00')
    const winter = denverInstant('2026-01-15', '14:00')

    const summerHour = summer.getUTCHours()
    const winterHour = winter.getUTCHours()

    expect(winterHour - summerHour).toBe(1)
  })

  it('handles the spring-forward morning', () => {
    // DST starts 2026-03-08. 03:00 exists; 02:30 does not. Booking hours start at 08:00, so
    // what matters is that a normal morning on the transition day still lands correctly.
    expect(denverInstant('2026-03-08', '10:00').toISOString()).toBe('2026-03-08T16:00:00.000Z')
  })

  it('handles the autumn fall-back morning', () => {
    // DST ends 2026-11-01, so by 10:00 the clocks are back on MST.
    expect(denverInstant('2026-11-01', '10:00').toISOString()).toBe('2026-11-01T17:00:00.000Z')
  })

  it('is stable across a date boundary', () => {
    // 20:00 Denver in summer is 02:00 UTC the NEXT day. Getting this wrong shifts a late
    // appointment onto the wrong calendar day.
    expect(denverInstant('2026-07-15', '20:00').toISOString()).toBe('2026-07-16T02:00:00.000Z')
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
  })

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('goes backwards', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('does not drift across a DST boundary', () => {
    // Adding a day is calendar arithmetic, not 86,400 seconds. A local-time Date would land on
    // the same day again when clocks go back.
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
  })
})

describe('weekStartOf', () => {
  it('returns the same day when it is already Sunday', () => {
    expect(weekStartOf('2026-07-26')).toBe('2026-07-26')
  })

  it('walks back to Sunday from mid-week', () => {
    expect(weekStartOf('2026-07-29')).toBe('2026-07-26')
  })

  it('walks back across a month boundary', () => {
    expect(weekStartOf('2026-08-01')).toBe('2026-07-26')
  })
})

describe('minutesOf', () => {
  it('converts a wall clock to minutes from midnight', () => {
    expect(minutesOf('00:00')).toBe(0)
    expect(minutesOf('08:00')).toBe(480)
    expect(minutesOf('13:45')).toBe(825)
    expect(minutesOf('20:00')).toBe(1200)
  })
})
