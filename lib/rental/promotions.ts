import 'server-only'

import { and, asc, eq, gt, gte, isNull, lte } from 'drizzle-orm'

import { db } from '@/lib/db'
import { rentalPromotions } from '@/lib/db/schema'
import {
  denverYmd,
  type DraftPromotion,
  type Promotion,
  type PromotionKind,
} from '@/lib/promotions'
import { todayInDenver } from '@/lib/validation'

// Reading and writing promotions. The arithmetic is in `lib/promotions.ts`, which the browser
// imports too — this half only talks to the database.
//
// EVERY READ IS "NOT FINISHED YET", never "live right now". A promotion that starts tomorrow
// has to be visible on the admin page so Keoni can see what she has queued, and one that ends
// tomorrow still prices a session booked for tomorrow. Which of them applies to a given session
// is `promotionFor`'s job, against that session's date — never against the clock. That split is
// why these functions do not filter on "is it running".

/** Rows mapped to the shape the pure module and the client both use. */
function toPromotion(row: {
  id: string
  name: string
  tierKey: string | null
  kind: string
  value: number
  startsOn: string
  endsOn: string
  endedAt: Date | null
}): Promotion {
  return {
    id: row.id,
    name: row.name,
    tierKey: row.tierKey,
    // `discount_type` carries a 'none' the table's check constraint refuses, so the cast is
    // narrowing a type the database has already guaranteed.
    kind: row.kind as PromotionKind,
    value: row.value,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    endedAt: row.endedAt,
  }
}

const COLUMNS = {
  id: rentalPromotions.id,
  name: rentalPromotions.name,
  tierKey: rentalPromotions.tierKey,
  kind: rentalPromotions.kind,
  value: rentalPromotions.value,
  startsOn: rentalPromotions.startsOn,
  endsOn: rentalPromotions.endsOn,
  endedAt: rentalPromotions.endedAt,
} as const

/**
 * Every promotion still to come or still running — and not one Keoni has stopped.
 *
 * What the pricing page lists, what a new promotion is checked for overlap against, and what
 * the schedule table reads to put "25% off until 31 October" under a fee.
 *
 * ENDED ONES ARE EXCLUDED, although their advertised window may still have days left in it.
 * They are no longer running, so listing them would be wrong on the page; and an ended
 * promotion must not block a replacement, which is the whole reason somebody ends one early.
 * They still have to be honoured for bookings already taken — that is `promotionsCovering`,
 * which is why the two queries differ.
 *
 * Past ones are excluded because nothing can be booked into the past.
 */
export async function activePromotions(): Promise<Promotion[]> {
  const rows = await db
    .select(COLUMNS)
    .from(rentalPromotions)
    .where(
      and(gte(rentalPromotions.endsOn, todayInDenver()), isNull(rentalPromotions.endedAt)),
    )
    .orderBy(asc(rentalPromotions.startsOn))

  return rows.map(toPromotion)
}

/**
 * Promotions that could apply on a given date, for pricing one known session.
 *
 * Reaches into the past on purpose. The sweep charges a session about twelve hours after it
 * ends, so by the time rent is taken for a Friday evening the promotion that covered it may
 * have finished — and that session must still be charged what it was quoted.
 *
 * INCLUDES ONES KEONI ENDED EARLY, unlike `activePromotions`. A promotion stopped on Tuesday
 * still owes the promotional price to every session booked before Tuesday, so the row has to
 * come back here for `promotionFor` to judge against the booking's own date. Filtering it out
 * in SQL would decide that question in the wrong place, and decide it wrongly.
 */
export async function promotionsCovering(on: Date): Promise<Promotion[]> {
  const ymd = denverYmd(on)

  const rows = await db
    .select(COLUMNS)
    .from(rentalPromotions)
    .where(and(gte(rentalPromotions.endsOn, ymd), lte(rentalPromotions.startsOn, ymd)))
    .orderBy(asc(rentalPromotions.startsOn))

  return rows.map(toPromotion)
}

export async function createPromotion(
  input: DraftPromotion,
  adminId: string,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(rentalPromotions)
    .values({
      name: input.name.trim(),
      tierKey: input.tierKey,
      kind: input.kind,
      value: input.value,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      createdBy: adminId,
    })
    .returning({ id: rentalPromotions.id })

  return row
}

/** What `endPromotionNow` did. A promotion that never started is a different event from one
 *  that was cut short, and the page says so differently. */
export type EndResult = 'ended' | 'cancelled' | 'not_running'

/**
 * Stops a promotion.
 *
 * TWO CASES, because they are genuinely different.
 *
 * One that has already started is ENDED: `endedAt` is stamped and the advertised window is left
 * exactly as it was. It stops applying to anything booked from this moment on, and every
 * session already on the calendar keeps the figure it was quoted.
 *
 * IT USED TO MOVE `endsOn` TO TODAY. That read as the tidier shape — one date predicate
 * answering "does this apply" everywhere — and it silently repriced work people had already
 * agreed to: a provider who booked next Tuesday at $85.50 would have been charged $95.00,
 * because by the time the sweep ran the window no longer reached them. Quoted one figure and
 * charged another is the exact bug the `on` parameter exists to prevent, and ending a promotion
 * was reintroducing it from the other end. The cost of fixing it is that "does this apply" now
 * takes the booking's date as well as the session's, which is `promotionFor`'s job.
 *
 * One that has NOT started is deleted outright. A promotion nobody was ever quoted has no
 * history worth keeping, so cancelling it is the honest shape rather than leaving a row that
 * ran for no days and has to be explained on every screen that lists it.
 */
export async function endPromotionNow(id: string, adminId: string): Promise<EndResult> {
  const today = todayInDenver()

  const cancelled = await db
    .delete(rentalPromotions)
    .where(
      and(
        eq(rentalPromotions.id, id),
        // STRICTLY AFTER TODAY. A promotion starting today has started — it is quoting prices
        // on the booking page right now — so `>=` deleted the row instead of ending it, taking
        // the record of what people were quoted with it. Ending one on its first day is the
        // ordinary way a mistake gets corrected, so this is the common case, not an edge.
        gt(rentalPromotions.startsOn, today),
      ),
    )
    .returning({ id: rentalPromotions.id })

  if (cancelled.length > 0) return 'cancelled'

  const ended = await db
    .update(rentalPromotions)
    .set({ endedAt: new Date(), endedBy: adminId })
    .where(
      and(
        eq(rentalPromotions.id, id),
        gte(rentalPromotions.endsOn, today),
        // Ending one twice would move `endedAt` forward and hand the promotion back to every
        // booking made between the two presses.
        isNull(rentalPromotions.endedAt),
      ),
    )
    .returning({ id: rentalPromotions.id })

  return ended.length > 0 ? 'ended' : 'not_running'
}

/**
 * Everything a session on the calendar might still be owed — ended ones included.
 *
 * WHAT `activePromotions` CANNOT ANSWER. That one says what is running, which is the right
 * question for the admin page and for refusing an overlap. It is the wrong question for a list
 * of bookings: a promotion Keoni ended on Tuesday still owes its price to every session booked
 * before Tuesday, and leaving it out would show a provider the full fee for a session their
 * card is about to be charged the promotional one for — the quoted-one-thing-charged-another
 * bug, told backwards.
 *
 * Scoped to windows that have not closed, because a list of appointments is upcoming and recent
 * work. One indexed read for a whole month of rows.
 */
export async function promotionsOwed(): Promise<Promotion[]> {
  const rows = await db
    .select(COLUMNS)
    .from(rentalPromotions)
    .where(gte(rentalPromotions.endsOn, todayInDenver()))
    .orderBy(asc(rentalPromotions.startsOn))

  return rows.map(toPromotion)
}
