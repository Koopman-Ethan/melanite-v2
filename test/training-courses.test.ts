import { describe, expect, it } from 'vitest'

import { validateCourse } from '@/lib/validate/training-course'

// Scheduling a training course.
//
// Admin-only and recoverable, so the stakes are lower than anything else tested today — but the
// numbers set here become the deposit a student is charged and the balance they are chased for,
// and a course with an impossible shape is one nobody can enrol on.

interface CourseInput {
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  maxStudents: number
  depositAmount: number
  totalPrice: number
}

const VALID: CourseInput = {
  day1Date: '2026-11-14',
  day1Start: '10:00',
  day1End: '16:00',
  day2Date: '2026-11-15',
  day2Start: '10:00',
  day2End: '14:00',
  maxStudents: 5,
  depositAmount: 500,
  totalPrice: 1400,
}

const withOverride = (o: Partial<CourseInput>) => validateCourse({ ...VALID, ...o })

describe('validateCourse', () => {
  it('accepts a normal two-day course', () => {
    expect(validateCourse(VALID)).toBeNull()
  })

  it('accepts a single-day course', () => {
    expect(withOverride({ day2Date: null })).toBeNull()
  })

  it('needs a real date for day one', () => {
    expect(withOverride({ day1Date: '' })).toMatch(/date for day one/i)
    expect(withOverride({ day1Date: '14/11/2026' })).toMatch(/date for day one/i)
  })

  it('needs day one to end after it starts', () => {
    expect(withOverride({ day1End: '10:00' })).toMatch(/end after it starts/i)
    expect(withOverride({ day1End: '09:00' })).toMatch(/end after it starts/i)
  })

  it('refuses malformed times', () => {
    expect(withOverride({ day1Start: '10am' })).toMatch(/times are not valid/i)
    expect(withOverride({ day1End: '25:00' })).toMatch(/times are not valid/i)
  })

  it('refuses a second day before the first', () => {
    expect(withOverride({ day2Date: '2026-11-13' })).toMatch(/before day one/i)
  })

  it('allows both days on the same date', () => {
    // Unusual but not wrong — a long single day split into two sessions.
    expect(withOverride({ day2Date: '2026-11-14' })).toBeNull()
  })

  it('validates day two only when there is one', () => {
    // Day two times are nonsense here but the date is null, so they are never reached. Without
    // that ordering, clearing day two while leaving stale times would block saving.
    expect(withOverride({ day2Date: null, day2Start: 'x', day2End: 'y' })).toBeNull()
  })

  it('needs at least one seat', () => {
    expect(withOverride({ maxStudents: 0 })).toMatch(/at least one seat/i)
    expect(withOverride({ maxStudents: -3 })).toMatch(/at least one seat/i)
    // Half a seat is not a thing, and the seat counter is an integer column.
    expect(withOverride({ maxStudents: 2.5 })).toMatch(/at least one seat/i)
  })

  it('needs a price', () => {
    expect(withOverride({ totalPrice: 0 })).toMatch(/set a course price/i)
    expect(withOverride({ totalPrice: -100 })).toMatch(/set a course price/i)
  })

  it('allows no deposit at all', () => {
    // Pay-in-full-only is a legitimate way to run a course.
    expect(withOverride({ depositAmount: 0 })).toBeNull()
  })

  it('refuses a negative deposit', () => {
    expect(withOverride({ depositAmount: -50 })).toMatch(/cannot be negative/i)
  })

  it('refuses a deposit larger than the price', () => {
    // Would leave a negative balance owed, which nothing downstream can represent — the
    // balance-due link would be asking for less than nothing.
    expect(withOverride({ depositAmount: 1500 })).toMatch(/more than the total price/i)
  })

  it('allows a deposit equal to the price', () => {
    // The whole cost up front, with nothing left owed. Not the same as a deposit exceeding it.
    expect(withOverride({ depositAmount: 1400 })).toBeNull()
  })
})
