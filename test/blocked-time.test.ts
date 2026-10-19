import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAvailability } from '@/lib/db/queries/availability'
import {
  blockTime,
  bookingsDuringBlock,
  getUpcomingBlocks,
  unblockTime,
} from '@/lib/db/queries/blocked-time'

// Laser time Melanite has taken out of service.
//
// Two things make this worth testing hard, and neither is the table.
//
// THE BOUNDARY. A block from noon to two has to leave 14:00 bookable, because that is what
// somebody blocking "noon to two" means. Off-by-one here either loses a bookable slot every
// time or lets a booking start inside a closed room.
//
// THE LEAK. `blocked_time` and `bookings` are different tables, so nothing in the database
// stops a booking landing inside a block — it is enforced by a `NOT EXISTS` fused into every
// insert that takes laser time, and there are FIVE of them across four files. A path that
// forgets it fails silently and only on the day somebody books into a closed room, so the
// tests below check the predicate every one of them shares.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let adminId = ''
const created: string[] = []

/** A window well clear of real data and of the other suites' fixtures. */
function window(dayOffset: number, hour: number, minutes = 60) {
  const start = new Date()
  start.setUTCDate(start.getUTCDate() + dayOffset)
  start.setUTCHours(hour, 0, 0, 0)
  return { start, end: new Date(start.getTime() + minutes * 60_000) }
}

async function block(start: Date, end: Date, reason = 'ZZ test') {
  const out = await blockTime({ start, end, reason, createdBy: adminId })
  if ('id' in out) created.push(out.id)
  return out
}

beforeAll(async () => {
  const [admin] = (await sql.query(
    `SELECT id FROM providers WHERE role IN ('platform_owner', 'developer') LIMIT 1`,
  )) as { id: string }[]
  adminId = admin.id
})

afterAll(async () => {
  await sql.query(`DELETE FROM blocked_time WHERE id = ANY($1::uuid[])`, [created])
})

describe('closing a window', () => {
  it('records who closed it and why', async () => {
    const { start, end } = window(400, 15)
    const out = await block(start, end, 'ZZ servicing')
    expect(out).toHaveProperty('id')

    const upcoming = await getUpcomingBlocks()
    const mine = upcoming.find((b) => 'id' in out && b.id === out.id)
    expect(mine?.reason).toBe('ZZ servicing')
    expect(mine?.createdBy).toBe(adminId)
  })

  it('refuses a window that ends before it starts', async () => {
    const { start, end } = window(401, 15)
    const out = await blockTime({ start: end, end: start, reason: null, createdBy: adminId })
    expect(out).toHaveProperty('error')
  })

  it('allows two blocks to overlap each other', async () => {
    // Blocking noon to two and then one to three means the laser is shut from noon to three,
    // which is what somebody doing that meant. Only a block over a BOOKING is a problem.
    const a = window(402, 12, 120)
    const b = window(402, 13, 120)

    expect(await block(a.start, a.end)).toHaveProperty('id')
    expect(await block(b.start, b.end)).toHaveProperty('id')
  })

  it('reopens cleanly', async () => {
    const { start, end } = window(403, 15)
    const out = await block(start, end)
    if (!('id' in out)) throw new Error('block failed')

    expect(await unblockTime(out.id)).toEqual({ removed: true })
    // A second attempt is harmless and says so, rather than reporting success twice.
    expect(await unblockTime(out.id)).toEqual({ removed: false })
  })
})

describe('the boundary', () => {
  it('leaves a slot that starts exactly when the block ends bookable', async () => {
    // The whole reason the predicate uses strict inequalities. "Noon to two" must not eat 14:00.
    const { start, end } = window(404, 18, 120)
    await block(start, end)

    const [touching] = (await sql.query(
      `SELECT exists (
         SELECT 1 FROM blocked_time bt
          WHERE bt.start_time < $2::timestamptz AND bt.end_time > $1::timestamptz
       ) AS hit`,
      [end.toISOString(), new Date(end.getTime() + 30 * 60_000).toISOString()],
    )) as { hit: boolean }[]

    expect(touching.hit).toBe(false)
  })

  it('catches a slot that starts one minute before the block ends', async () => {
    const { start, end } = window(405, 18, 120)
    await block(start, end)

    const probe = new Date(end.getTime() - 60_000)
    const [overlapping] = (await sql.query(
      `SELECT exists (
         SELECT 1 FROM blocked_time bt
          WHERE bt.start_time < $2::timestamptz AND bt.end_time > $1::timestamptz
       ) AS hit`,
      [probe.toISOString(), new Date(probe.getTime() + 30 * 60_000).toISOString()],
    )) as { hit: boolean }[]

    expect(overlapping.hit).toBe(true)
  })
})

describe('what a provider sees', () => {
  it('shows a blocked slot as unavailable, with no reason of its own', async () => {
    // Blocked time is folded in with bookings on purpose, so a provider reads the same wording
    // as any other taken slot. A separate reason would tell them Melanite had shut the room,
    // which is often nobody else's business.
    const denverDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
      new Date(Date.now() + 406 * 86_400_000),
    )

    const before = await getAvailability(denverDay, 30)
    const open = before.slots.filter((s) => s.available)
    expect(open.length, 'need an open slot to block').toBeGreaterThan(4)

    const target = open[4]
    const out = await block(target.startTime, target.endTime)
    if (!('id' in out)) throw new Error('block failed')

    const after = await getAvailability(denverDay, 30)
    const slot = after.slots.find((s) => s.startTime.getTime() === target.startTime.getTime())

    expect(slot?.available).toBe(false)
    expect(slot?.reason).toBe('taken')
  })

  it('frees the slot again when reopened', async () => {
    const denverDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
      new Date(Date.now() + 407 * 86_400_000),
    )

    const before = await getAvailability(denverDay, 30)
    const target = before.slots.filter((s) => s.available)[3]

    const out = await block(target.startTime, target.endTime)
    if (!('id' in out)) throw new Error('block failed')

    const blocked = await getAvailability(denverDay, 30)
    expect(
      blocked.slots.find((s) => s.startTime.getTime() === target.startTime.getTime())?.available,
    ).toBe(false)

    await unblockTime(out.id)

    const reopened = await getAvailability(denverDay, 30)
    expect(
      reopened.slots.find((s) => s.startTime.getTime() === target.startTime.getTime())?.available,
    ).toBe(true)
  })
})

describe('not blocking over an appointment', () => {
  it('names what is in the way rather than refusing blankly', async () => {
    // The guard that cannot be a database constraint, because blocked_time and bookings are
    // different tables. Blocking booked time would leave the appointment standing while
    // whoever blocked it believes the room is shut.
    const [existing] = (await sql.query(
      `SELECT start_time, end_time FROM bookings
        WHERE status IN ('upcoming', 'completed') ORDER BY start_time DESC LIMIT 1`,
    )) as { start_time: string; end_time: string }[]

    if (!existing) return

    const start = new Date(existing.start_time)
    const end = new Date(existing.end_time)

    const conflicts = await bookingsDuringBlock(start, end)
    expect(conflicts.length).toBeGreaterThan(0)

    const out = await blockTime({ start, end, reason: 'ZZ should refuse', createdBy: adminId })
    expect(out).toHaveProperty('error')
    if ('error' in out) {
      expect(out.error).toMatch(/already booked/i)
      // Names the appointment. "Something conflicts" sends somebody hunting through a calendar.
      expect(out.error).toMatch(/Move or cancel/i)
    }
  })
})

describe('every path that takes laser time', () => {
  it('checks blocked time wherever it checks training courses', async () => {
    // A path that forgets one fails silently — only on the day somebody books into a closed
    // room. Asserted against the source, because there is no runtime seam that covers them all.
    //
    // Two of the four files went on 14 October with packages and prepaid. The list is shorter
    // and the rule is unchanged: every remaining way of taking laser time asks both questions.
    const { readFileSync } = await import('node:fs')

    const paths = ['app/app/book/actions.ts', 'app/app/admin/tools/actions.ts']

    for (const path of paths) {
      const source = readFileSync(path, 'utf8')
      const courses = source.split('overlapsTrainingCourse(startTime').length - 1
      const blocks = source.split('overlapsBlockedTime(startTime').length - 1

      expect(courses, `${path} should check training courses`).toBeGreaterThan(0)
      expect(blocks, `${path} checks ${courses} course window(s) but ${blocks} blocked`).toBe(
        courses,
      )
    }
  })
})
