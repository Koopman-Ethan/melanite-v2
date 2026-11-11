import { describe, expect, it } from 'vitest'

import {
  addMonthsYmd,
  completedTerm,
  contractEndsOn,
  daysUntil,
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

// A lease runs on a signed contract and ends when it does (11 November 2026).
describe('the contract term', () => {
  const lease = { startsOn: '2026-11-10', termMonths: 6 }

  it('ends six months after the lease starts', () => {
    expect(contractEndsOn(lease)).toBe('2027-05-10')
  })

  it('ends a further six months on once renewed, from the old end and not from today', () => {
    expect(contractEndsOn({ ...lease, termMonths: 12 })).toBe('2027-11-10')
  })

  it('does not let notice run a lease past its contract', () => {
    // Notice given ten days before the contract ends: the contract's end wins.
    expect(endsAfterNotice('2027-04-30', '2027-05-10')).toBe('2027-05-10')
    // Notice given early: thirty days, as before.
    expect(endsAfterNotice('2027-02-01', '2027-05-10')).toBe('2027-03-03')
  })

  it('counts the days left, and goes negative once it has run out', () => {
    expect(daysUntil('2027-05-10', '2027-04-10')).toBe(30)
    expect(daysUntil('2027-05-10', '2027-05-11')).toBe(-1)
  })
})

describe('completedTerm', () => {
  const lease = { startsOn: '2026-11-10', termMonths: 6 }

  it('is true when the lease ran to the end of its contract, with or without notice', () => {
    expect(completedTerm({ ...lease, endsOn: '2027-05-10' })).toBe(true)
  })

  it('is false when notice ended it before six months', () => {
    expect(completedTerm({ ...lease, endsOn: '2027-03-03' })).toBe(false)
  })

  it('is false when Keoni ended it early, for not paying', () => {
    expect(completedTerm({ ...lease, endsOn: '2027-01-15' })).toBe(false)
  })

  it('is false in the second term of a renewed lease that left before that term was up', () => {
    expect(completedTerm({ ...lease, termMonths: 12, endsOn: '2027-08-01' })).toBe(false)
  })
})
