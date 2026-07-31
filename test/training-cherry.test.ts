import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getEnrollments } from '@/lib/db/queries/training'

// Financing a training course.
//
// Cherry on a booking would be wrong — that money reaches the provider, and the debt runs the
// other way. Training is the opposite and the cleanest case there is: it is entirely Melanite's
// revenue, no split, no Connect transfer, and Cherry pays Melanite directly. Nobody is owed a
// share of it.
//
// What makes it different from a card is TIME. A card checkout resolves in a minute; a
// financing decision takes days, and Cherry's ACH arrives days after that. Everything below is
// about not losing the student's seat in the meantime, and not claiming they have paid.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let courseId = ''
const made: string[] = []

async function enrol(email: string, cherry: boolean, heldMinutes: number) {
  const rows = (await sql.query(
    `INSERT INTO training_enrollments
       (training_course_id, first_name, last_name, email, payment_status, seat_held_until,
        cherry_started_at)
     VALUES ($1, 'ZZ', 'Cherry', $2, 'unpaid', now() + ($3 || ' minutes')::interval, $4)
     RETURNING id`,
    [courseId, email, String(heldMinutes), cherry ? new Date().toISOString() : null],
  )) as { id: string }[]
  made.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO training_courses
       (day1_date, day1_start, day1_end, max_students, deposit_amount, total_price, status)
     VALUES ('2095-06-01', '10:00', '16:00', 5, '500.00', '1400.00', 'scheduled')
     RETURNING id`,
  )) as { id: string }[]
  courseId = rows[0].id
})

afterAll(async () => {
  for (const id of made) {
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM training_enrollments WHERE id = $1`, [id])
  }
  if (courseId) await sql.query(`DELETE FROM training_courses WHERE id = $1`, [courseId])
})

describe('a student financing through Cherry', () => {
  it('is not marked as paid', async () => {
    // The rule the whole feature turns on. They have applied for financing, not been approved
    // for it, and marking an enrolment paid because a button was clicked would put a student in
    // a classroom Melanite has not been paid for.
    const id = await enrol('zz.cherry.1@example.com', true, 72 * 60)
    const [row] = (await sql.query(
      `SELECT payment_status, cherry_started_at FROM training_enrollments WHERE id = $1`,
      [id],
    )) as Record<string, unknown>[]

    expect(row.payment_status).toBe('unpaid')
    expect(row.cherry_started_at).not.toBeNull()
  })

  it('holds the seat far longer than a card checkout', async () => {
    // Twenty minutes is right for typing a card number and wrong for a financing decision. A
    // seat released on the card timer means an approved student comes back to a full course —
    // worse than holding one that might not convert, because it wastes their money too.
    const card = await enrol('zz.cherry.card@example.com', false, 20)
    const cherry = await enrol('zz.cherry.2@example.com', true, 72 * 60)

    const rows = (await sql.query(
      `SELECT id, extract(epoch from (seat_held_until - now())) / 3600 AS hours_left
         FROM training_enrollments WHERE id = ANY($1)`,
      [[card, cherry]],
    )) as { id: string; hours_left: string }[]

    const held = new Map(rows.map((r) => [r.id, Number(r.hours_left)]))
    expect(held.get(card)).toBeLessThan(1)
    expect(held.get(cherry)).toBeGreaterThan(24)
  })

  it('is not held forever', async () => {
    // An abandoned application must not keep one of five seats indefinitely. The hold expires
    // like any other; it is just measured in days.
    const [row] = (await sql.query(
      `SELECT seat_held_until IS NOT NULL AS bounded FROM training_enrollments
        WHERE cherry_started_at IS NOT NULL LIMIT 1`,
    )) as { bounded: boolean }[]
    expect(row.bounded).toBe(true)
  })

  it('reaches Keoni, with its age', async () => {
    // Recorded and shown nowhere is the failure this repeats from the package work. The age is
    // the part she acts on — a two-hour-old application needs nothing, a two-week-old one does.
    const id = await enrol('zz.cherry.3@example.com', true, 72 * 60)
    const row = (await getEnrollments(courseId)).find((e) => e.id === id)

    expect(row, 'a Cherry applicant must appear on the course page').toBeDefined()
    expect(row!.cherryStartedAt).not.toBeNull()
    expect(row!.paymentStatus).toBe('unpaid')
    expect(Number(row!.owed)).toBeCloseTo(1400, 2)
  })

  it('an ordinary enrolment carries no Cherry mark', async () => {
    const id = await enrol('zz.cherry.plain@example.com', false, 20)
    const row = (await getEnrollments(courseId)).find((e) => e.id === id)
    expect(row!.cherryStartedAt).toBeNull()
  })
})
