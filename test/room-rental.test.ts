import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { releaseExpiredHolds, slotBounds, slotPrice } from '@/lib/db/queries/room-rental'

// Daily room rental.
//
// Two things worth pinning down. The slot boundaries are wall-clock times in Denver turned into
// instants, which is where this codebase has been wrong before. And occupancy is enforced by a
// Postgres EXCLUDE constraint rather than by a uniqueness rule on (date, slot) — the difference
// is that `full` correctly collides with `am`, which a unique index would happily allow, and
// the room would have been let twice.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const SETTINGS = {
  enabled: true,
  fullDayPrice: '100.00',
  halfDayPrice: '60.00',
  amStart: '08:00',
  amEnd: '13:00',
  pmEnd: '18:00',
  advanceDays: 60,
}

let providerId = ''
const made: string[] = []

async function hold(date: string, slot: 'am' | 'pm' | 'full', opts: { expired?: boolean } = {}) {
  const { startAt, endAt } = slotBounds(date, slot, SETTINGS)
  const rows = (await sql.query(
    `INSERT INTO room_bookings
       (provider_id, rental_date, slot_type, price, status, start_at, end_at, hold_expires_at)
     VALUES ($1, $2::date, $3::room_slot_type, $4, 'pending', $5::timestamptz, $6::timestamptz,
             now() + ($7::text || ' minutes')::interval)
     RETURNING id`,
    [
      providerId,
      date,
      slot,
      slotPrice(slot, SETTINGS),
      startAt.toISOString(),
      endAt.toISOString(),
      opts.expired ? '-5' : '20',
    ],
  )) as { id: string }[]
  made.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id FROM providers WHERE status = 'active' ORDER BY email LIMIT 1`,
  )) as { id: string }[]
  providerId = rows[0].id
})

afterAll(async () => {
  for (const id of made) await sql.query(`DELETE FROM room_bookings WHERE id = $1`, [id])
})

describe('slot boundaries', () => {
  it('turns Denver wall-clock into the right instant in summer', () => {
    // July is MDT, UTC-6. 08:00 local is 14:00Z.
    const { startAt, endAt } = slotBounds('2026-07-15', 'am', SETTINGS)
    expect(startAt.toISOString()).toBe('2026-07-15T14:00:00.000Z')
    expect(endAt.toISOString()).toBe('2026-07-15T19:00:00.000Z')
  })

  it('turns Denver wall-clock into the right instant in winter', () => {
    // January is MST, UTC-7. The same 08:00 local is 15:00Z — an hour later in UTC. Storing a
    // fixed offset would put every winter rental an hour out.
    const { startAt } = slotBounds('2026-01-15', 'am', SETTINGS)
    expect(startAt.toISOString()).toBe('2026-01-15T15:00:00.000Z')
  })

  it('runs the afternoon from the end of the morning, with no gap', () => {
    // A gap between am and pm would be an hour the room is sold to nobody; an overlap would let
    // the same hour be sold twice.
    const am = slotBounds('2026-07-15', 'am', SETTINGS)
    const pm = slotBounds('2026-07-15', 'pm', SETTINGS)
    expect(pm.startAt.toISOString()).toBe(am.endAt.toISOString())
  })

  it('makes a full day exactly the two halves end to end', () => {
    const full = slotBounds('2026-07-15', 'full', SETTINGS)
    const am = slotBounds('2026-07-15', 'am', SETTINGS)
    const pm = slotBounds('2026-07-15', 'pm', SETTINGS)
    expect(full.startAt.toISOString()).toBe(am.startAt.toISOString())
    expect(full.endAt.toISOString()).toBe(pm.endAt.toISOString())
  })

  it('prices a full day and a half day differently', () => {
    expect(slotPrice('full', SETTINGS)).toBe('100.00')
    expect(slotPrice('am', SETTINGS)).toBe('60.00')
    expect(slotPrice('pm', SETTINGS)).toBe('60.00')
  })
})

describe('the room cannot be let twice', () => {
  it('refuses the same block twice', async () => {
    await hold('2097-06-10', 'am')
    await expect(hold('2097-06-10', 'am')).rejects.toThrow()
  })

  it('refuses a full day on a morning that is taken', async () => {
    // The case a unique index on (date, slot_type) would have allowed: different slot names,
    // same hours. The EXCLUDE constraint compares ranges, so it catches this.
    await expect(hold('2097-06-10', 'full')).rejects.toThrow()
  })

  it('allows the afternoon when only the morning is taken', async () => {
    const id = await hold('2097-06-10', 'pm')
    expect(id).toBeTruthy()
  })

  it('refuses a morning on a day already sold as a full day', async () => {
    await hold('2097-06-11', 'full')
    await expect(hold('2097-06-11', 'am')).rejects.toThrow()
    await expect(hold('2097-06-11', 'pm')).rejects.toThrow()
  })

  it('keeps days independent', async () => {
    const id = await hold('2097-06-12', 'full')
    expect(id).toBeTruthy()
  })
})

describe('abandoned checkouts', () => {
  it('release the block so somebody else can take it', async () => {
    // Without this an abandoned checkout takes the room off the market permanently — the
    // pending row still occupies the range as far as the constraint is concerned.
    await hold('2097-06-20', 'full', { expired: true })
    await expect(hold('2097-06-20', 'am')).rejects.toThrow()

    const released = await releaseExpiredHolds()
    expect(released).toBeGreaterThan(0)

    const id = await hold('2097-06-20', 'am')
    expect(id).toBeTruthy()
  })

  it('leaves a live hold alone', async () => {
    await hold('2097-06-21', 'full')
    await releaseExpiredHolds()

    const [row] = (await sql.query(
      `SELECT status FROM room_bookings WHERE rental_date = '2097-06-21'::date`,
    )) as { status: string }[]
    // Someone mid-checkout keeps their block. Sweeping them would sell the room out from under
    // a person who is entering their card details.
    expect(row.status).toBe('pending')
  })
})
