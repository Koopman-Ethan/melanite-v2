import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getEnrollmentDetail, refreshPaymentStatus } from '@/lib/db/queries/training'

// Does a training payment ever mark the student as paid?
//
// It did not, for a reason nothing surfaced: the UPDATE used a LATERAL subquery correlated on
// `e.id`, and `e` is the UPDATE target rather than a FROM entry, so Postgres rejected the whole
// statement with "invalid reference to FROM-clause entry for table e". Every call. Always.
//
// The failure was invisible from every direction. It throws from inside the webhook AFTER the
// ledger row is written, so the money was always recorded correctly and revenue was always
// right — Stripe simply retried a handler that could not succeed, and the retry was a no-op
// because the ledger insert is guarded. Meanwhile a student who paid in full still read as
// unpaid, and the balances screen showed everyone owing everything.
//
// Tested through the real function, against a real course, because the bug was in SQL that
// compiles, type-checks and lints perfectly.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let courseId = ''
let enrollmentId = ''
const ledgerIds: string[] = []

async function pay(amount: string, entryType: 'purchase' | 'refund' = 'purchase') {
  const rows = (await sql.query(
    `INSERT INTO ledger_entries
       (source, payer, entry_type, subject_type, subject_id, gross_amount, tip_amount,
        provider_payout, melanite_cut, payment_method, payout_status)
     VALUES ('training', 'student', $1, 'training_enrollment', $2, $3, '0.00', '0.00', $3,
             'cash', 'paid')
     RETURNING id`,
    [entryType, enrollmentId, amount],
  )) as { id: string }[]
  ledgerIds.push(rows[0].id)
  await refreshPaymentStatus(enrollmentId)
}

async function status(): Promise<string> {
  const detail = await getEnrollmentDetail(enrollmentId)
  return detail?.paymentStatus ?? '(missing)'
}

beforeAll(async () => {
  const course = (await sql.query(
    `INSERT INTO training_courses
       (day1_date, day1_start, day1_end, max_students, deposit_amount, total_price, status)
     VALUES ('2094-03-01', '10:00', '16:00', 5, '500.00', '1400.00', 'scheduled')
     RETURNING id`,
  )) as { id: string }[]
  courseId = course[0].id

  const enrolment = (await sql.query(
    `INSERT INTO training_enrollments
       (training_course_id, first_name, last_name, email, payment_status)
     VALUES ($1, 'ZZ', 'Student', 'zz.student@example.com', 'unpaid')
     RETURNING id`,
    [courseId],
  )) as { id: string }[]
  enrollmentId = enrolment[0].id
})

afterAll(async () => {
  for (const id of ledgerIds) await sql.query(`DELETE FROM ledger_entries WHERE id = $1`, [id])
  if (enrollmentId) await sql.query(`DELETE FROM training_enrollments WHERE id = $1`, [enrollmentId])
  if (courseId) await sql.query(`DELETE FROM training_courses WHERE id = $1`, [courseId])
})

describe('training payment status', () => {
  it('starts unpaid, and refreshing does not throw', async () => {
    // The whole bug in one line: this call used to raise before touching anything.
    await refreshPaymentStatus(enrollmentId)
    expect(await status()).toBe('unpaid')
  })

  it('becomes partial after a deposit', async () => {
    await pay('500.00')
    expect(await status()).toBe('partial')
  })

  it('becomes paid in full once the balance lands', async () => {
    await pay('900.00')
    expect(await status()).toBe('paid_in_full')
  })

  it('reports what is still owed', async () => {
    const detail = await getEnrollmentDetail(enrollmentId)
    expect(Number(detail?.paid)).toBeCloseTo(1400, 2)
    expect(Number(detail?.owed)).toBeCloseTo(0, 2)
  })

  it('a refund puts them back to partial', async () => {
    // Derived from the ledger rather than incremented, so a refund is just another row and the
    // status follows. v1 kept a running total on the enrolment and this is exactly where it
    // drifted.
    await pay('400.00', 'refund')
    expect(await status()).toBe('partial')
  })

  it('claims a seat once payment exists, and only one', async () => {
    // The counter the public page reads. It is recomputed here rather than incremented, so a
    // replayed webhook cannot inflate it.
    const [row] = (await sql.query(
      `SELECT seats_taken FROM training_courses WHERE id = $1`,
      [courseId],
    )) as { seats_taken: number }[]
    expect(row.seats_taken).toBe(1)

    await refreshPaymentStatus(enrollmentId)
    const [again] = (await sql.query(
      `SELECT seats_taken FROM training_courses WHERE id = $1`,
      [courseId],
    )) as { seats_taken: number }[]
    expect(again.seats_taken, 'refreshing twice must not take a second seat').toBe(1)
  })
})
