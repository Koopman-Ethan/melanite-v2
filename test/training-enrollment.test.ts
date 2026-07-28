import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Stripe is STUBBED here, and that is not laziness.
//
// The write key in .env.local is a real test-mode key, so the first version of this file
// happily created three $500 PaymentIntents on every run. Unconfirmed, so no money moved, but
// a unit test should not be making remote objects — it is slow, it litters the Stripe
// dashboard, and it makes the suite depend on Stripe being up.
//
// Stubbed as SUCCEEDING rather than failing, because a failure would exercise the release path
// and put the seat back, which is the opposite of what these tests are checking.
vi.mock('@/lib/stripe/client', () => ({
  stripePost: async () => ({ id: 'pi_stub', client_secret: 'pi_stub_secret_x' }),
  stripeWritesEnabled: () => true,
  friendlyStripeError: (_err: unknown, fallback: string) => fallback,
}))

const { enrollAndPayDeposit } = await import('@/app/training/actions')

// Enrolling on a training course.
//
// PUBLIC — no session, anyone can reach it, which makes the validation the only thing between
// the form and a row. These drive the real action against a real course.
//
// The seat arithmetic is covered separately in seats.test.ts. What is here is the path a person
// actually takes to reach it.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let courseId = ''
const MAX = 2

const valid = {
  firstName: 'Zztrain',
  lastName: 'Student',
  phone: '208-555-0190',
  licenseNumber: 'RN-ZZ-1',
  payInFull: false,
}

const emailFor = (n: number) => `zz.enroll.${courseId.slice(0, 8)}.${n}@example.com`

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO training_courses (day1_date, max_students, deposit_amount, total_price, status)
     VALUES (current_date + 90, $1, '500.00', '1400.00', 'scheduled')
     RETURNING id`,
    [MAX],
  )) as { id: string }[]
  courseId = rows[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM training_enrollments WHERE training_course_id = $1`, [courseId])
  await sql.query(`DELETE FROM training_courses WHERE id = $1`, [courseId])
})

describe('what the form will not accept', () => {
  it('needs a first and last name', async () => {
    expect((await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(1), firstName: '' })).error)
      .toMatch(/first and last name/i)
    expect((await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(1), lastName: '  ' })).error)
      .toMatch(/first and last name/i)
  })

  it('needs an email that could exist', async () => {
    // The balance link is emailed weeks later, so a typo here is a student who never gets it.
    for (const email of ['', 'nope', 'a@b', 'a b@c.com']) {
      expect((await enrollAndPayDeposit({ ...valid, courseId, email })).error).toMatch(/valid email/i)
    }
  })

  it('needs a phone number', async () => {
    expect((await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(1), phone: ' ' })).error)
      .toMatch(/phone number/i)
  })

  it('needs a license number', async () => {
    // Was accepted and silently discarded until recently. It is a clinical laser course, and
    // who was trained under what license is a record Melanite has to be able to produce.
    expect(
      (await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(1), licenseNumber: '' }))
        .error,
    ).toMatch(/license number/i)
  })

  it('refuses a course that does not exist', async () => {
    const result = await enrollAndPayDeposit({
      ...valid,
      courseId: '00000000-0000-0000-0000-000000000000',
      email: emailFor(1),
    })
    expect(result.error).toMatch(/does not exist/i)
  })

  it('refuses a course that is no longer open', async () => {
    await sql.query(`UPDATE training_courses SET status = 'cancelled' WHERE id = $1`, [courseId])
    const result = await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(1) })
    expect(result.error).toMatch(/no longer open/i)
    await sql.query(`UPDATE training_courses SET status = 'scheduled' WHERE id = $1`, [courseId])
  })

  it('writes no enrolment row when validation fails', async () => {
    // The invariant behind all of the above: a refused form leaves nothing behind, so a student
    // who mistypes their email is not half-enrolled under it.
    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM training_enrollments WHERE training_course_id = $1`,
      [courseId],
    )) as { n: number }[]
    expect(row.n).toBe(0)
  })
})

describe('a seat is held before payment', () => {
  it('claims one and holds it', async () => {
    // The seat and its hold exist as soon as checkout starts — before any money moves.
    await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(10) })

    const [row] = (await sql.query(
      `SELECT payment_status, seat_held_until, license_number
         FROM training_enrollments WHERE training_course_id = $1 AND email = $2`,
      [courseId, emailFor(10)],
    )) as Record<string, unknown>[]

    expect(row).toBeTruthy()
    expect(row.payment_status).toBe('unpaid')
    expect(row.license_number).toBe('RN-ZZ-1')
    // Held, not free — an abandoned checkout must not leave the seat open to somebody else
    // while the first person is still entering their card.
    expect(row.seat_held_until).not.toBeNull()

    const [course] = (await sql.query(`SELECT seats_taken FROM training_courses WHERE id = $1`, [
      courseId,
    ])) as { seats_taken: number }[]
    expect(Number(course.seats_taken)).toBe(1)
  })

  it('does not claim a second seat when the same person retries', async () => {
    // A failed card is the common case. Re-submitting must reuse the row and the hold rather
    // than eating another place on a two-seat course.
    await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(10) })

    const [course] = (await sql.query(`SELECT seats_taken FROM training_courses WHERE id = $1`, [
      courseId,
    ])) as { seats_taken: number }[]
    expect(Number(course.seats_taken)).toBe(1)

    const [rows] = (await sql.query(
      `SELECT count(*)::int AS n FROM training_enrollments
        WHERE training_course_id = $1 AND email = $2`,
      [courseId, emailFor(10)],
    )) as { n: number }[]
    expect(rows.n).toBe(1)
  })

  it('turns people away once the course is full', async () => {
    await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(11) })

    const result = await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(12) })
    expect(result.error).toMatch(/now full/i)

    const [course] = (await sql.query(`SELECT seats_taken FROM training_courses WHERE id = $1`, [
      courseId,
    ])) as { seats_taken: number }[]
    expect(Number(course.seats_taken)).toBe(MAX)
  })

  it('refuses somebody who has already paid', async () => {
    await sql.query(
      `UPDATE training_enrollments SET payment_status = 'partial', seat_held_until = NULL
        WHERE training_course_id = $1 AND email = $2`,
      [courseId, emailFor(10)],
    )

    const result = await enrollAndPayDeposit({ ...valid, courseId, email: emailFor(10) })
    expect(result.error).toMatch(/already enrolled/i)
  })
})
