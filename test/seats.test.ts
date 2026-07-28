import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Training seats, against a real database.
//
// This is a concurrency bug, and concurrency bugs cannot be tested with mocks — the whole
// question is what Postgres does when two statements arrive at once. So this talks to the same
// database everything else does, creates its own course, and deletes it afterwards.
//
// What was wrong: the old check counted paid enrolments in one statement and acted on the
// result in another, with a Stripe checkout in between. Two people could both pass the check,
// both pay, and both be enrolled on the last seat of a five-seat course. The window was minutes.

const { neon } = await import('@neondatabase/serverless')
const url = process.env.DATABASE_URL
const sql = neon(url!)

let courseId = ''
const MAX = 5

/** The claim, exactly as `claimSeat` issues it. Written out rather than imported because the
 *  query module is `server-only` and this needs to run outside a request. */
async function claim(): Promise<boolean> {
  const rows = (await sql.query(
    `UPDATE training_courses SET seats_taken = seats_taken + 1
      WHERE id = $1 AND seats_taken < max_students
      RETURNING seats_taken`,
    [courseId],
  )) as unknown[]
  return rows.length > 0
}

async function seatsTaken(): Promise<number> {
  const rows = (await sql.query(`SELECT seats_taken FROM training_courses WHERE id = $1`, [
    courseId,
  ])) as { seats_taken: number }[]
  return Number(rows[0].seats_taken)
}

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO training_courses (day1_date, max_students, deposit_amount, total_price, status)
     VALUES (current_date + 60, $1, '500.00', '1400.00', 'scheduled')
     RETURNING id`,
    [MAX],
  )) as { id: string }[]
  courseId = rows[0].id
})

afterAll(async () => {
  if (courseId) {
    await sql.query(`DELETE FROM training_enrollments WHERE training_course_id = $1`, [courseId])
    await sql.query(`DELETE FROM training_courses WHERE id = $1`, [courseId])
  }
})

describe('seat claiming', () => {
  it('hands out exactly the seats that exist, under concurrency', async () => {
    // Twenty simultaneous attempts on a five-seat course. Serialised by the row lock the
    // conditional UPDATE takes, so five win and fifteen are refused — every time, not usually.
    const results = await Promise.all(Array.from({ length: 20 }, () => claim()))

    expect(results.filter(Boolean)).toHaveLength(MAX)
    expect(results.filter((r) => !r)).toHaveLength(20 - MAX)
    expect(await seatsTaken()).toBe(MAX)
  })

  it('refuses every further claim once full', async () => {
    expect(await claim()).toBe(false)
    expect(await seatsTaken()).toBe(MAX)
  })

  it('never exceeds capacity even if the guard is bypassed', async () => {
    // The CHECK constraint is the backstop. If some future code path increments without the
    // capacity test, the database refuses rather than quietly overselling.
    await expect(
      sql.query(`UPDATE training_courses SET seats_taken = seats_taken + 1 WHERE id = $1`, [
        courseId,
      ]),
    ).rejects.toThrow()
    expect(await seatsTaken()).toBe(MAX)
  })

  it('gives a seat back when one is released', async () => {
    await sql.query(
      `UPDATE training_courses SET seats_taken = greatest(seats_taken - 1, 0) WHERE id = $1`,
      [courseId],
    )
    expect(await seatsTaken()).toBe(MAX - 1)
    expect(await claim()).toBe(true)
    expect(await seatsTaken()).toBe(MAX)
  })

  it('cannot be driven below zero by repeated releases', async () => {
    for (let i = 0; i < MAX + 3; i++) {
      await sql.query(
        `UPDATE training_courses SET seats_taken = greatest(seats_taken - 1, 0) WHERE id = $1`,
        [courseId],
      )
    }
    // `greatest(x, 0)` rather than a bare subtraction: a double-release on a refund must not
    // leave a negative count that then lets the course oversell by however far it went under.
    expect(await seatsTaken()).toBe(0)
  })
})

describe('seat reconciliation', () => {
  it('counts a live hold as taken and an expired one as free', async () => {
    const mk = async (status: string, heldMinutes: number | null) => {
      const rows = (await sql.query(
        `INSERT INTO training_enrollments
           (training_course_id, first_name, last_name, email, payment_status, seat_held_until)
         VALUES ($1, 'Zz', 'Seat', $2, $3::training_payment_status,
                 CASE WHEN $4::int IS NULL THEN NULL
                      ELSE now() + ($4::text || ' minutes')::interval END)
         RETURNING id`,
        [courseId, `zz.seat.${Date.now()}.${Math.round(performance.now() * 1000)}@example.com`, status, heldMinutes],
      )) as { id: string }[]
      return rows[0].id
    }

    await mk('unpaid', 15) // holding
    await mk('unpaid', -5) // lapsed
    await mk('partial', null) // paid, no hold needed
    await mk('unpaid', null) // never started checkout

    await sql.query(
      `UPDATE training_courses c
          SET seats_taken = (
            SELECT count(*) FROM training_enrollments e
             WHERE e.training_course_id = c.id
               AND (e.payment_status <> 'unpaid'
                    OR (e.seat_held_until IS NOT NULL AND e.seat_held_until > now()))
          )
        WHERE c.id = $1`,
      [courseId],
    )

    // The live hold and the paid enrolment. Not the lapsed hold, and not the abandoned form —
    // an unfinished checkout must not keep a seat off the market.
    expect(await seatsTaken()).toBe(2)
  })
})
