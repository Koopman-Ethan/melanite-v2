import { describe, expect, it } from 'vitest'

import {
  addMonthsYmd,
  completedTerm,
  endsAfterNotice,
  firstOfNextMonth,
  leaseSchedule,
} from '@/lib/rooms/lease-schedule'

// When a monthly lease's rent is taken. Keoni's rule (4 November 2026): a part-month is prorated,
// then rent comes out on the 1st; 30 days' notice; the deposit comes back after a completed term.

describe('leaseSchedule', () => {
  it('prorates a start today and anchors the cycle on the next 1st', () => {
    expect(leaseSchedule('2026-11-10', '2026-11-10')).toEqual({
      kind: 'prorate',
      periodStart: '2026-11-10',
      backdated: false,
      anchor: '2026-12-01',
    })
  })

  it('backdates a start earlier this month, so the part-month is charged from move-in', () => {
    expect(leaseSchedule('2026-11-03', '2026-11-10')).toEqual({
      kind: 'prorate',
      periodStart: '2026-11-03',
      backdated: true,
      anchor: '2026-12-01',
    })
  })

  it('defers a lease that starts on a later 1st — the nail stations from 1 December', () => {
    expect(leaseSchedule('2026-12-01', '2026-11-10')).toEqual({
      kind: 'future',
      firstCharge: '2026-12-01',
    })
  })

  it('crosses the year boundary', () => {
    expect(leaseSchedule('2026-12-15', '2026-12-15')).toMatchObject({ anchor: '2027-01-01' })
  })

  it('refuses a later mid-month start rather than charging days nobody occupies', () => {
    expect(leaseSchedule('2026-11-20', '2026-11-10')).toHaveProperty('error')
  })

  it('refuses to backdate across a 1st', () => {
    expect(leaseSchedule('2026-10-25', '2026-11-10')).toHaveProperty('error')
  })
})

describe('dates', () => {
  it('finds the next 1st', () => {
    expect(firstOfNextMonth('2026-01-31')).toBe('2026-02-01')
  })

  it('ends a lease 30 days after notice', () => {
    expect(endsAfterNotice('2027-04-10')).toBe('2027-05-10')
  })

  it('clamps a month-end start rather than rolling into the next month', () => {
    expect(addMonthsYmd('2026-08-31', 6)).toBe('2027-02-28')
  })
})

describe('completedTerm', () => {
  const lease = { startsOn: '2026-11-10', termMonths: 6 }

  it('is true when notice runs the lease to six months or beyond', () => {
    expect(completedTerm({ ...lease, noticeGivenOn: '2027-04-10', endsOn: '2027-05-10' })).toBe(true)
  })

  it('is false when the lease ends before six months', () => {
    expect(completedTerm({ ...lease, noticeGivenOn: '2027-02-01', endsOn: '2027-03-03' })).toBe(false)
  })

  it('is false when it ended without notice — ended by Keoni, for not paying', () => {
    expect(completedTerm({ ...lease, noticeGivenOn: null, endsOn: '2027-06-01' })).toBe(false)
  })
})
