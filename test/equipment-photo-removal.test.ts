import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getUnbracketedSessions } from '@/lib/db/queries/equipment'

// Removing a photograph must not rewrite who complied.
//
// Melanite can destroy a photograph — a client caught in frame is health information sitting in a
// store built for a machine, and she should not have to ask a developer to get rid of it. The
// dangerous version of that feature deletes the whole row, because every query asking "was this
// session accounted for?" asks whether a check row EXISTS. Delete the row and a provider who
// photographed the laser silently becomes one who did not, months later, with nothing to show it
// ever happened.
//
// So the bytes go and the row stays, marked. These tests pin the consequence rather than the
// mechanism: a session with a removed photo must still be absent from the gap list.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
let bookingId = ''
const CLIENT = `ZZ PHOTO REMOVAL ${Date.now()}`

/** Yesterday, so the booking has finished and is eligible for the gap list at all.
 *
 *  A STARTING POINT, not a fixed time. The laser is one shared resource guarded by the
 *  `bookings_no_overlap` exclusion constraint, and dev is rebuilt nightly from production — so
 *  whether 26 hours ago happens to be free depends entirely on who was booked yesterday. It was
 *  free until a refresh imported a real 15:30 appointment into exactly that hour, and the whole
 *  file then failed in `beforeAll` with an error about an exclusion constraint.
 *
 *  `e2e/equipment-check.spec.ts` already solved this with a retry loop for the same reason. */
const HOURS_BACK_START = 26

async function gapListHasOurBooking(): Promise<boolean> {
  const sessions = await getUnbracketedSessions(7)
  return sessions.some((s) => s.bookingId === bookingId)
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerServiceId = rows[0].id
  providerId = rows[0].provider_id

  // Walk backwards an hour at a time until the laser is free. Every candidate stays inside the
  // seven-day window `gapListHasOurBooking` asks for, so which one wins does not change what is
  // being tested — only whether the fixture can exist at all.
  let lastError: unknown
  for (let back = HOURS_BACK_START; back < HOURS_BACK_START + 24; back += 1) {
    const startIso = new Date(Date.now() - back * 60 * 60_000).toISOString()
    const endIso = new Date(Date.now() - (back - 1) * 60 * 60_000).toISOString()
    try {
      const booking = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, client_name, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, $3, '100.00', '100.00', 'checkout_link', 60, $4::timestamptz,
                 $5::timestamptz, 'completed')
         RETURNING id`,
        [providerId, providerServiceId, CLIENT, startIso, endIso],
      )) as { id: string }[]
      bookingId = booking[0].id
      break
    } catch (err) {
      // Only an overlap is worth retrying. Anything else is a real failure and must not be
      // swallowed twenty-four times over.
      if (!String(err).includes('bookings_no_overlap')) throw err
      lastError = err
    }
  }
  if (!bookingId) throw lastError ?? new Error('could not place the fixture booking')
})

afterAll(async () => {
  await sql.query(`DELETE FROM equipment_checks WHERE booking_id = $1`, [bookingId])
  await sql.query(`DELETE FROM bookings WHERE client_name = $1`, [CLIENT])
})

describe('removing a photograph', () => {
  it('lists the session as a gap while nobody has photographed it', async () => {
    // The control. Without this the later assertions could pass because the query never returns
    // this booking at all — for a reason having nothing to do with deletion.
    expect(await gapListHasOurBooking()).toBe(true)
  })

  it('stops listing it once an arrival photo exists', async () => {
    await sql.query(
      `INSERT INTO equipment_checks (booking_id, provider_id, kind, storage_key, mime_type, size_bytes)
       VALUES ($1, $2, 'before', $3, 'image/jpeg', 1000)`,
      [bookingId, providerId, `equipment/dev/${bookingId}-before.jpg`],
    )
    expect(await gapListHasOurBooking()).toBe(false)
  })

  it('STILL does not list it after the photograph is destroyed', async () => {
    // The whole point. She photographed the laser; that stays true after the image is gone.
    await sql.query(
      `UPDATE equipment_checks
         SET photo_deleted_at = now(), photo_deleted_by = $2, photo_deleted_reason = 'a client was in frame'
       WHERE booking_id = $1`,
      [bookingId, providerId],
    )

    expect(
      await gapListHasOurBooking(),
      'deleting the photo turned a provider who complied into one who did not',
    ).toBe(false)
  })

  it('keeps the row, and what happened to it', async () => {
    const rows = (await sql.query(
      `SELECT storage_key, photo_deleted_at, photo_deleted_by, photo_deleted_reason
         FROM equipment_checks WHERE booking_id = $1`,
      [bookingId],
    )) as {
      storage_key: string
      photo_deleted_at: string | null
      photo_deleted_by: string | null
      photo_deleted_reason: string | null
    }[]

    expect(rows).toHaveLength(1)
    expect(rows[0].photo_deleted_at).not.toBeNull()
    expect(rows[0].photo_deleted_by).toBe(providerId)
    expect(rows[0].photo_deleted_reason).toBe('a client was in frame')
    // The key is deliberately not nulled: it documents which object was destroyed.
    expect(rows[0].storage_key).toContain('equipment/dev/')
  })
})
