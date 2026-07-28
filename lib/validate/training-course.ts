// Training course rules. Out here for the same reason as the package template: a
// `'use server'` module may only export async functions.

/** Shared with the balance-due-date action, which validates the same shape. */
export const DATE = /^\d{4}-\d{2}-\d{2}$/
// Hours and minutes are RANGE-checked, not merely shape-checked. `/^\d{2}:\d{2}$/` accepts
// "25:00" and "10:99" — and "25:00" is even correctly "after" 10:00 as a string, so every
// other check passes and the course is scheduled at an hour that does not exist.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function validateCourse(input: {
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string | null
  day2Start: string
  day2End: string
  maxStudents: number
  depositAmount: number
  totalPrice: number
}): string | null {
  if (!DATE.test(input.day1Date)) return 'Pick a date for day one.'
  if (!TIME.test(input.day1Start) || !TIME.test(input.day1End)) return 'Day one times are not valid.'
  if (input.day1End <= input.day1Start) return 'Day one must end after it starts.'

  if (input.day2Date) {
    if (!DATE.test(input.day2Date)) return 'Day two date is not valid.'
    if (input.day2Date < input.day1Date) return 'Day two cannot be before day one.'
    if (!TIME.test(input.day2Start) || !TIME.test(input.day2End)) {
      return 'Day two times are not valid.'
    }
    if (input.day2End <= input.day2Start) return 'Day two must end after it starts.'
  }

  if (!Number.isInteger(input.maxStudents) || input.maxStudents < 1) {
    return 'A course needs at least one seat.'
  }
  if (!(input.totalPrice > 0)) return 'Set a course price.'
  if (input.depositAmount < 0) return 'The deposit cannot be negative.'
  // A deposit larger than the price would leave a negative balance owed, which nothing
  // downstream is prepared to represent.
  if (input.depositAmount > input.totalPrice) {
    return 'The deposit cannot be more than the total price.'
  }

  return null
}
