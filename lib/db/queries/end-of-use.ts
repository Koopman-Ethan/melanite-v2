import 'server-only'

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  endOfUseChecklists,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'
import {
  END_OF_USE_ITEMS,
  END_OF_USE_STARTED_AT,
  labelsFor,
  missingKeys,
  reportedLabelsFor,
} from '@/lib/end-of-use'

// Reading the close-out record.
//
// A separate module from `queries/equipment.ts`, which says in its own header that it is about
// photographs. These are about what somebody declared they did, which is a different question
// with a different failure mode — a photo is missing or it is not, whereas a close-out can exist
// and still be mostly empty.
//
// Nothing here is scoped to a provider: every caller is an admin page behind `requireAdmin()`,
// the same arrangement the equipment queries use.

/** How long after a session ends before a missing close-out becomes an exception rather than a
 *  task.
 *
 *  The same twelve hours `checkWindowOpen` gives a provider to file one. Before that it is still
 *  theirs to do and listing it would be nagging Keoni about something nobody is late for. */
const CLOSEOUT_GRACE_HOURS = 12

export interface CloseoutRecord {
  id: string
  bookingId: string
  providerName: string
  recordedAt: Date
  itemsDone: number
  itemCount: number
  /** What was NOT ticked, in the wording that provider was shown. */
  missingLabels: string[]
  deviceIssue: boolean
  deviceIssueNote: string | null
  note: string | null
  serviceName: string
  startTime: Date
}

const CLOSEOUT_COLUMNS = {
  id: endOfUseChecklists.id,
  bookingId: endOfUseChecklists.bookingId,
  providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
  recordedAt: endOfUseChecklists.recordedAt,
  completedItems: endOfUseChecklists.completedItems,
  itemCount: endOfUseChecklists.itemCount,
  deviceIssue: endOfUseChecklists.deviceIssue,
  deviceIssueNote: endOfUseChecklists.deviceIssueNote,
  note: endOfUseChecklists.note,
  serviceName: services.name,
  startTime: bookings.startTime,
}

type RawCloseout = {
  id: string
  bookingId: string
  providerName: string
  recordedAt: Date
  completedItems: string[]
  itemCount: number
  deviceIssue: boolean
  deviceIssueNote: string | null
  note: string | null
  serviceName: string
  startTime: Date
}

function asCloseout(row: RawCloseout): CloseoutRecord {
  const { completedItems, ...rest } = row
  return {
    ...rest,
    itemsDone: completedItems.length,
    // Resolved to labels here rather than in the page or the email, so the wording lives in one
    // place and no template needs to import policy.
    missingLabels: labelsFor(missingKeys(completedItems)),
  }
}

/**
 * Device faults reported on a close-out.
 *
 * Pairs with `getFlaggedChecks` — a provider can report a problem by flagging a photograph or by
 * saying so here, and Keoni has to see both or the second kind goes unnoticed. Any surface that
 * shows one must show the other.
 */
export async function getCloseoutIssues(sinceDays = 30): Promise<CloseoutRecord[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60_000)

  const rows = await db
    .select(CLOSEOUT_COLUMNS)
    .from(endOfUseChecklists)
    .innerJoin(providers, eq(endOfUseChecklists.providerId, providers.id))
    .innerJoin(bookings, eq(endOfUseChecklists.bookingId, bookings.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(and(eq(endOfUseChecklists.deviceIssue, true), gte(endOfUseChecklists.recordedAt, since)))
    .orderBy(desc(endOfUseChecklists.recordedAt))

  return rows.map(asCloseout)
}

export interface UnclosedSession {
  bookingId: string
  startTime: Date
  endTime: Date
  providerName: string
  serviceName: string
}

/**
 * Sessions that were used and never signed off, once it is too late to sign off.
 *
 * A record, not a to-do — exactly like `getUnbracketedSessions`, and for the same reason. Past the
 * twelve-hour window other people have used the room, so a check-off filed now would describe a
 * state this provider did not leave it in. Oldest first, because age is what matters in a list of
 * things nobody dealt with.
 *
 * Bounded by `END_OF_USE_STARTED_AT` so the page does not open with every session that predates
 * the feature listed as a failure. That mistake has already been made once here, with sixteen
 * unfixable rows, and it is what makes a page one nobody opens twice.
 */
export async function getSessionsWithoutCloseout(
  sinceDays = 30,
  /** Overridable so a test can place a fixture deterministically either side of both bounds,
   *  rather than depending on what time of day the suite happens to run. `isUnbracketed` takes
   *  `now` for the same reason. */
  now: Date = new Date(),
): Promise<UnclosedSession[]> {
  const window = new Date(now.getTime() - sinceDays * 24 * 60 * 60_000)
  const since = window > END_OF_USE_STARTED_AT ? window : END_OF_USE_STARTED_AT
  const cutoff = new Date(now.getTime() - CLOSEOUT_GRACE_HOURS * 60 * 60_000)

  return db
    .select({
      bookingId: bookings.id,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      serviceName: services.name,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        // The same pair the laser's overlap constraint treats as occupying the machine. A
        // cancellation or a no-show never touched the room and is not a gap.
        sql`${bookings.status} in ('upcoming', 'completed')`,
        lt(bookings.endTime, cutoff),
        gte(bookings.startTime, since),
        sql`not exists (
          select 1 from ${endOfUseChecklists}
          where ${endOfUseChecklists}.booking_id = ${bookings}.id
        )`,
      ),
    )
    .orderBy(asc(bookings.startTime))
}

export interface ConditionalItemCount {
  key: string
  label: string
  times: number
}

/**
 * How often each CONDITIONAL item was ticked.
 *
 * This counts what happened, not what was skipped. That inversion is deliberate and it follows
 * from making twenty items required: a required item is ticked on every stored row by definition,
 * so counting omissions could only ever return the five conditionals — and "Report damaged
 * eyewear: not ticked 40 times" describes forty sessions where the eyewear was fine. It would be
 * a page of failures that are not failures, which is how a page stops being read.
 *
 * Ticked, these are real events: a shortage, damage, an adverse event. That IS the thing the paper
 * form could never total up, and it is the reason `completed_items` is an array rather than
 * twenty-five columns.
 *
 * Driven by the current conditional list, passed as a parameter, so a retired item stops being
 * counted rather than lingering.
 */
export async function getConditionalItemCounts(sinceDays = 30): Promise<ConditionalItemCount[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60_000)
  // `sql.param`, not a bare interpolation. Drizzle expands a JS array into comma-separated
  // parameters, which Postgres reads as a row constructor and refuses to cast — "cannot cast type
  // record to text[]". This sends the whole list through as one text[] value instead.
  const keys = END_OF_USE_ITEMS.filter((i) => !i.required).map((i) => i.key)

  const rows = await db.execute<{ key: string; times: number }>(sql`
    select k.key, count(*)::int as times
    from ${endOfUseChecklists} c
    cross join unnest(${sql.param(keys)}::text[]) as k(key)
    where c.recorded_at >= ${since}
      and k.key = any(c.completed_items)
    group by k.key
    order by times desc, k.key asc
  `)

  return rows.rows.map((r) => ({
    key: r.key,
    // The REPORTING phrasing, not the checklist label. This block is a list of findings — the
    // labels are imperatives, and "Notify management of any supply shortages — 6×" under a
    // heading that says "What came up" reads as an instruction to whoever is looking at it.
    // Same mistake this made in the close-out email before it was caught in a real send.
    label: reportedLabelsFor([r.key])[0] ?? labelsFor([r.key])[0] ?? r.key,
    times: Number(r.times),
  }))
}

/** The close-out log, newest first. The counterpart to `getRecentChecks`. */
export async function getRecentCloseouts(limit = 20): Promise<CloseoutRecord[]> {
  const rows = await db
    .select(CLOSEOUT_COLUMNS)
    .from(endOfUseChecklists)
    .innerJoin(providers, eq(endOfUseChecklists.providerId, providers.id))
    .innerJoin(bookings, eq(endOfUseChecklists.bookingId, bookings.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .orderBy(desc(endOfUseChecklists.recordedAt))
    .limit(limit)

  return rows.map(asCloseout)
}
