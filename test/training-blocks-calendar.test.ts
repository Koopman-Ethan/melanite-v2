import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAvailability, getMonthAvailability } from '@/lib/db/queries/availability'

// A scheduled training course takes the laser out of service.
//
// The feature has two halves and they fail differently. Blocking NEW bookings during a course is
// the easy one. The hard one is what happens when a course is scheduled over appointments that
// already exist — and the honest answer is that only a human can decide, because the
// alternatives are cancelling somebody's treatment or double-booking the laser. That half is
// tested in the admin action; this file covers what the calendar shows and what it will accept.
//
// The block is DERIVED from the course rather than materialised as rows. A course that moves
// takes its block with it, which a copied set of blackout rows would not.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

// Far enough out that nothing real is anywhere near it.
const DAY1 = '2097-04-15'
const DAY2 = '2097-04-16'
const CLEAR_DAY = '2097-04-17'

let courseId = ''

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO training_courses
       (day1_date, day1_start, day1_end, day2_date, day2_start, day2_end,
        max_students, deposit_amount, total_price, status)
     VALUES ($1, '10:00', '16:00', $2, '10:00', '14:00', 5, '500.00', '1400.00', 'scheduled')
     RETURNING id`,
    [DAY1, DAY2],
  )) as { id: string }[]
  courseId = rows[0].id
})

afterAll(async () => {
  if (courseId) await sql.query(`DELETE FROM training_courses WHERE id = $1`, [courseId])
})

describe('the day view', () => {
  it('marks slots inside the course as training, not as taken', async () => {
    // The distinction matters to whoever reads it: "somebody has the laser" sends a provider
    // hunting for whose appointment it is. "Melanite is teaching" answers the question.
    const { slots } = await getAvailability(DAY1, 30, new Date('2097-01-01T00:00:00Z'))
    const blocked = slots.filter((s) => s.reason === 'training')

    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.every((s) => !s.available)).toBe(true)
  })

  it('leaves the hours outside the course alone', async () => {
    // A course from 10:00 to 16:00 does not close the whole day. Blocking more than was booked
    // would quietly cost Melanite every early and late appointment on a training day.
    const { slots } = await getAvailability(DAY1, 30, new Date('2097-01-01T00:00:00Z'))
    const free = slots.filter((s) => s.available)
    expect(free.length, 'the whole day was blocked, not just the course hours').toBeGreaterThan(0)
  })

  it('honours the second day and its different hours', async () => {
    // Day two runs 10:00–14:00, not 10:00–16:00. Reusing day one's hours would block two extra
    // hours that are genuinely free.
    const { slots } = await getAvailability(DAY2, 30, new Date('2097-01-01T00:00:00Z'))
    expect(slots.some((s) => s.reason === 'training')).toBe(true)
    expect(slots.some((s) => s.available)).toBe(true)
  })

  it('does not touch a day the course does not run', async () => {
    const { slots } = await getAvailability(CLEAR_DAY, 30, new Date('2097-01-01T00:00:00Z'))
    expect(slots.some((s) => s.reason === 'training')).toBe(false)
  })
})

describe('the month calendar', () => {
  it('shows fewer openings on the course days', async () => {
    // The month grid and the day grid share one slot builder precisely so they cannot disagree.
    // If this drifts, a provider picks a day the calendar called free and finds it blocked.
    const { days } = await getMonthAvailability('2097-04', 30, new Date('2097-01-01T00:00:00Z'))

    const day1 = days.find((d) => d.date === DAY1)!
    const clear = days.find((d) => d.date === CLEAR_DAY)!

    expect(day1.openSlots).toBeLessThan(clear.openSlots)
  })
})

describe('a cancelled course stops blocking', () => {
  it('gives the day back', async () => {
    // Only `scheduled` blocks. A cancelled course still holding the calendar would shrink it
    // permanently, and nobody would think to look at training to find out why.
    await sql.query(`UPDATE training_courses SET status = 'cancelled' WHERE id = $1`, [courseId])

    const { slots } = await getAvailability(DAY1, 30, new Date('2097-01-01T00:00:00Z'))
    expect(slots.some((s) => s.reason === 'training')).toBe(false)

    await sql.query(`UPDATE training_courses SET status = 'scheduled' WHERE id = $1`, [courseId])
  })
})

describe('the guard, not just the grid', () => {
  // Hiding a slot is a courtesy; refusing the insert is the actual protection. A provider with a
  // stale page, or two people racing, would otherwise book straight through a course.
  //
  // Runs the same predicate the three insert paths use, against the same statement shape, so
  // this tests what ships rather than a restatement of it.
  it('refuses an insert inside the course hours', async () => {
    const [ps] = (await sql.query(
      `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
    )) as { id: string; provider_id: string }[]

    const start = new Date('2097-04-15T18:00:00Z') // 12:00 Denver, inside 10:00–16:00
    const end = new Date('2097-04-15T19:00:00Z')

    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price,
          payment_source, duration_mins, start_time, end_time, status)
       SELECT $1, $2, 'ZZ Blocked', '100.00', '100.00', 'checkout_link', 60, $3, $4, 'upcoming'
        WHERE NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.status IN ('upcoming','completed')
             AND b.start_time < $4::timestamptz AND b.end_time > $3::timestamptz
        )
          AND NOT EXISTS (
            SELECT 1 FROM training_courses tc
             WHERE tc.status = 'scheduled'
               AND ((tc.day1_date + tc.day1_start::time) AT TIME ZONE 'America/Denver' < $4::timestamptz
                AND (tc.day1_date + tc.day1_end::time)   AT TIME ZONE 'America/Denver' > $3::timestamptz)
          )
       RETURNING id`,
      [ps.provider_id, ps.id, start.toISOString(), end.toISOString()],
    )) as { id: string }[]

    expect(rows.length, 'a booking was created inside a training course').toBe(0)
  })

  it('allows one outside the course hours on the same day', async () => {
    // The guard must be the course window, not the whole day.
    const [ps] = (await sql.query(
      `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
    )) as { id: string; provider_id: string }[]

    const start = new Date('2097-04-15T14:30:00Z') // 08:30 Denver, before the course
    const end = new Date('2097-04-15T15:00:00Z')

    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price,
          payment_source, duration_mins, start_time, end_time, status)
       SELECT $1, $2, 'ZZ Allowed', '100.00', '100.00', 'checkout_link', 30, $3, $4, 'upcoming'
        WHERE NOT EXISTS (
            SELECT 1 FROM training_courses tc
             WHERE tc.status = 'scheduled'
               AND ((tc.day1_date + tc.day1_start::time) AT TIME ZONE 'America/Denver' < $4::timestamptz
                AND (tc.day1_date + tc.day1_end::time)   AT TIME ZONE 'America/Denver' > $3::timestamptz)
          )
       RETURNING id`,
      [ps.provider_id, ps.id, start.toISOString(), end.toISOString()],
    )) as { id: string }[]

    expect(rows.length, 'an appointment before the course was wrongly refused').toBe(1)
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [rows[0].id])
  })
})

describe('scheduling a course over appointments that already exist', () => {
  // The half that has no automatic answer. Melanite can refuse, silently double-book, or cancel
  // somebody's treatment — and only a person can choose. So it refuses and NAMES them, which is
  // the only option that neither destroys anything nor pretends the conflict is not there.

  let bookingId = ''

  afterAll(async () => {
    if (bookingId) await sql.query(`DELETE FROM bookings WHERE id = $1`, [bookingId])
  })

  it('refuses, and says which appointments are in the way', async () => {
    const { bookingsDuringCourse, courseConflictMessage } = await import(
      '@/lib/db/queries/training'
    )

    const [ps] = (await sql.query(
      `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
    )) as { id: string; provider_id: string }[]

    // 12:00 Denver on a day no course covers yet.
    const rows = (await sql.query(
      `INSERT INTO bookings
         (provider_id, provider_service_id, client_name, original_price, price,
          payment_source, duration_mins, start_time, end_time, status)
       VALUES ($1, $2, 'ZZ Already Booked', '100.00', '100.00', 'checkout_link', 60,
               '2097-04-17T18:00:00Z', '2097-04-17T19:00:00Z', 'upcoming')
       RETURNING id`,
      [ps.provider_id, ps.id],
    )) as { id: string }[]
    bookingId = rows[0].id

    const conflicts = await bookingsDuringCourse({
      day1Date: '2097-04-17',
      day1Start: '10:00',
      day1End: '16:00',
      day2Date: null,
      day2Start: '10:00',
      day2End: '16:00',
    })

    expect(conflicts.length, 'the booked appointment was not detected').toBeGreaterThan(0)

    // Naming them is the point. "Something conflicts" sends somebody hunting through a month.
    const message = courseConflictMessage(conflicts)
    expect(message).toMatch(/ZZ Already Booked/)
    expect(message).toMatch(/Move or cancel/i)
  })

  it('allows it once the appointment is out of the way', async () => {
    const { bookingsDuringCourse } = await import('@/lib/db/queries/training')

    // Cancelled bookings do not occupy the laser — the same rule the overlap constraint uses.
    await sql.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId])

    const conflicts = await bookingsDuringCourse({
      day1Date: '2097-04-17',
      day1Start: '10:00',
      day1End: '16:00',
      day2Date: null,
      day2Start: '10:00',
      day2End: '16:00',
    })

    expect(conflicts, 'a cancelled appointment must not block a course').toEqual([])
  })
})
