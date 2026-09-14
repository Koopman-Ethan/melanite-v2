import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isUniqueViolation } from '@/lib/db/errors'
import {
  getCloseoutIssues,
  getConditionalItemCounts,
  getSessionsWithoutCloseout,
} from '@/lib/db/queries/end-of-use'
import {
  END_OF_USE_ITEMS,
  END_OF_USE_ITEM_COUNT,
  END_OF_USE_STARTED_AT,
  END_OF_USE_VERSION,
} from '@/lib/end-of-use'

// The close-out record, against a real database.
//
// The pure rules are covered in `end-of-use.test.ts`. What can only be checked here is whether
// the constraints actually hold, whether the `unnest` aggregate returns what it claims, and
// whether a session drops off the exceptions list when somebody signs it off — which is the
// question the admin page is built on.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''
let providerServiceId = ''
let bookingId = ''
let recentBookingId = ''
let countedBookingId = ''
const CLIENT = `ZZ CLOSEOUT ${Date.now()}`
const RECENT_CLIENT = `ZZ CLOSEOUT RECENT ${Date.now()}`
const COUNTED_CLIENT = `ZZ CLOSEOUT COUNTED ${Date.now()}`

// Fixtures are placed relative to END_OF_USE_STARTED_AT, not to the wall clock, and the query is
// asked with an explicit `now`. Anchoring to `Date.now()` cannot work: the start bound is the day
// the feature ships, so "26 hours ago" is before it and would be excluded by design — and a
// fixture squeezed into the gap between the two bounds would pass or fail depending on what time
// of day the suite ran.
const ANCHOR = END_OF_USE_STARTED_AT.getTime()
const NOW = new Date(ANCHOR + 48 * 60 * 60_000)

/** `recorded_at` defaults to the real now, but the fixtures sit at the anchor, which may be days
 *  either side of it. Wide enough to cover both without depending on which. */
const SINCE_DAYS = 3650

/** An hour after the feature started, and well past the twelve-hour grace by NOW. */
const startIso = new Date(ANCHOR + 60 * 60_000).toISOString()
const endIso = new Date(ANCHOR + 2 * 60 * 60_000).toISOString()

/** Finished two hours before NOW — inside the grace, so still theirs to file. */
const recentStartIso = new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString()
const recentEndIso = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString()

async function unclosedHas(id: string): Promise<boolean> {
  const rows = await getSessionsWithoutCloseout(7, NOW)
  return rows.some((s) => s.bookingId === id)
}

async function insertBooking(client: string, startAt: string, endAt: string): Promise<string> {
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_name, original_price, price, payment_source,
        duration_mins, start_time, end_time, status)
     VALUES ($1, $2, $3, '100.00', '100.00', 'checkout_link', 60, $4::timestamptz,
             $5::timestamptz, 'completed')
     RETURNING id`,
    [providerId, providerServiceId, client, startAt, endAt],
  )) as { id: string }[]
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerServiceId = rows[0].id
  providerId = rows[0].provider_id

  bookingId = await insertBooking(CLIENT, startIso, endIso)
  recentBookingId = await insertBooking(RECENT_CLIENT, recentStartIso, recentEndIso)
  countedBookingId = await insertBooking(
    COUNTED_CLIENT,
    new Date(ANCHOR + 4 * 60 * 60_000).toISOString(),
    new Date(ANCHOR + 5 * 60 * 60_000).toISOString(),
  )
})

afterAll(async () => {
  await sql.query(`DELETE FROM end_of_use_checklists WHERE booking_id = any($1::uuid[])`, [
    [bookingId, recentBookingId, countedBookingId],
  ])
  await sql.query(`DELETE FROM bookings WHERE client_name = any($1::text[])`, [
    [CLIENT, RECENT_CLIENT, COUNTED_CLIENT],
  ])
})

describe('sessions nobody signed off', () => {
  it('lists a finished session with no close-out', async () => {
    // The control. Without it the later assertions could pass for reasons unrelated to signing.
    expect(await unclosedHas(bookingId)).toBe(true)
  })

  it('does NOT list one that finished two hours ago', async () => {
    // Inside the twelve-hour window it is still the provider's to file. Listing it would put a
    // task on Keoni's exceptions page and teach her the page is full of things nobody is late
    // for, which is how it stops being read.
    expect(await unclosedHas(recentBookingId)).toBe(false)
  })

  it('stops listing it once it has been closed out', async () => {
    await sql.query(
      `INSERT INTO end_of_use_checklists
         (booking_id, provider_id, version, completed_items, item_count, device_issue)
       VALUES ($1, $2, $3, $4::text[], $5, false)`,
      [
        bookingId,
        providerId,
        END_OF_USE_VERSION,
        END_OF_USE_ITEMS.filter((i) => i.required).map((i) => i.key),
        END_OF_USE_ITEM_COUNT,
      ],
    )
    // A PARTIAL close-out still counts as signed off. The exceptions list is about sessions
    // nobody accounted for at all; how thoroughly they accounted for it is the digest's question.
    expect(await unclosedHas(bookingId)).toBe(false)
  })
})

describe('the constraints', () => {
  it('refuses a second close-out for the same booking', async () => {
    // One row per booking, so nobody can quietly replace what they declared. Asserting that
    // `isUniqueViolation` RECOGNISES it, not merely that the insert failed — the action turns
    // this into "that session was already closed out" and a change to the driver's error shape
    // would silently turn it back into a stack trace.
    let caught: unknown
    try {
      await sql.query(
        `INSERT INTO end_of_use_checklists
           (booking_id, provider_id, version, completed_items, item_count, device_issue)
         VALUES ($1, $2, $3, '{}'::text[], $4, false)`,
        [bookingId, providerId, END_OF_USE_VERSION, END_OF_USE_ITEM_COUNT],
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(isUniqueViolation(caught)).toBe(true)
  })

  it('refuses a reported issue with no description', async () => {
    await expect(
      sql.query(
        `INSERT INTO end_of_use_checklists
           (booking_id, provider_id, version, completed_items, item_count, device_issue,
            device_issue_note)
         VALUES ($1, $2, $3, '{}'::text[], $4, true, null)`,
        [recentBookingId, providerId, END_OF_USE_VERSION, END_OF_USE_ITEM_COUNT],
      ),
    ).rejects.toThrow()
  })

  it('refuses a description filed against "no issues"', async () => {
    await expect(
      sql.query(
        `INSERT INTO end_of_use_checklists
           (booking_id, provider_id, version, completed_items, item_count, device_issue,
            device_issue_note)
         VALUES ($1, $2, $3, '{}'::text[], $4, false, 'the handpiece is cracked')`,
        [recentBookingId, providerId, END_OF_USE_VERSION, END_OF_USE_ITEM_COUNT],
      ),
    ).rejects.toThrow()
  })

  it('refuses more ticked items than the list had', async () => {
    await expect(
      sql.query(
        `INSERT INTO end_of_use_checklists
           (booking_id, provider_id, version, completed_items, item_count, device_issue)
         VALUES ($1, $2, $3, $4::text[], 2, false)`,
        [recentBookingId, providerId, END_OF_USE_VERSION, ['a', 'b', 'c']],
      ),
    ).rejects.toThrow()
  })
})

describe('what came up', () => {
  it('counts the conditional items that WERE ticked, not the ones that were not', async () => {
    // The `unnest` aggregate, and the justification for an array over twenty-five columns. It
    // counts EVENTS — a shortage, damage found — because every required item is ticked on every
    // stored row, so totalling omissions could only ever list the five conditionals and would
    // render a quiet month as a page of failures.
    const conditional = END_OF_USE_ITEMS.filter((i) => !i.required)

    // Measured as a DELTA, not against zero. This runs on the shared dev database, which carries
    // close-outs filed by hand during testing — asserting a global count would pass or fail on
    // whatever somebody happened to tick last week.
    const before = new Map(
      (await getConditionalItemCounts(SINCE_DAYS)).map((c) => [c.key, c.times]),
    )

    // Tick one, and only that one moves.
    await sql.query(
      `INSERT INTO end_of_use_checklists
         (booking_id, provider_id, version, completed_items, item_count, device_issue)
       VALUES ($1, $2, $3, $4::text[], $5, false)`,
      [
        countedBookingId,
        providerId,
        END_OF_USE_VERSION,
        [...END_OF_USE_ITEMS.filter((i) => i.required).map((i) => i.key), conditional[0].key],
        END_OF_USE_ITEM_COUNT,
      ],
    )

    const after = await getConditionalItemCounts(SINCE_DAYS)
    const afterByKey = new Map(after.map((c) => [c.key, c.times]))

    // The one we ticked went up by exactly one.
    expect(afterByKey.get(conditional[0].key) ?? 0).toBe((before.get(conditional[0].key) ?? 0) + 1)

    // The others did not move — the aggregate counts the item, not the row.
    for (const item of conditional.slice(1)) {
      expect(afterByKey.get(item.key) ?? 0, `${item.key} should not have moved`).toBe(
        before.get(item.key) ?? 0,
      )
    }

    // And it resolves the key to the wording a provider actually saw.
    expect(after.find((c) => c.key === conditional[0].key)?.label).toBe(conditional[0].label)
  })
})

describe('reported device faults', () => {
  it('surfaces a close-out that reported one', async () => {
    await sql.query(
      `INSERT INTO end_of_use_checklists
         (booking_id, provider_id, version, completed_items, item_count, device_issue,
          device_issue_note)
       VALUES ($1, $2, $3, '{}'::text[], $4, true, 'ZZ handpiece window is chipped')`,
      [recentBookingId, providerId, END_OF_USE_VERSION, END_OF_USE_ITEM_COUNT],
    )

    const issues = await getCloseoutIssues(SINCE_DAYS)
    const ours = issues.find((i) => i.bookingId === recentBookingId)
    expect(ours?.deviceIssueNote).toBe('ZZ handpiece window is chipped')
    // Nothing ticked, so every item is named as missing — the loudest possible record.
    expect(ours?.missingLabels).toHaveLength(END_OF_USE_ITEM_COUNT)
    expect(ours?.itemsDone).toBe(0)
  })
})
