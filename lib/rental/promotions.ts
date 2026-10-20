import 'server-only'

import { and, asc, eq, gte, lte } from 'drizzle-orm'

import { db } from '@/lib/db'
import { rentalPromotions } from '@/lib/db/schema'
import { denverYmd, type Promotion, type PromotionKind } from '@/lib/promotions'
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
} as const

/**
 * Every promotion that has not finished — running now, or starting later.
 *
 * What the pricing page lists, what the booking form prices against, and what a new promotion
 * is checked for overlap against. Past ones are excluded because nothing can be booked into
 * the past; `promotionsCovering` is the one that reaches back.
 */
export async function activePromotions(): Promise<Promotion[]> {
  const rows = await db
    .select(COLUMNS)
    .from(rentalPromotions)
    .where(gte(rentalPromotions.endsOn, todayInDenver()))
    .orderBy(asc(rentalPromotions.startsOn))

  return rows.map(toPromotion)
}

/**
 * Promotions that could apply on a given date, for pricing one known session.
 *
 * Reaches into the past on purpose. The sweep charges a session about twelve hours after it
 * ends, so by the time rent is taken for a Friday evening the promotion that covered it may
 * have finished — and that session must still be charged what it was quoted.
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
  input: Omit<Promotion, 'id'>,
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
 * TWO CASES, because they are genuinely different. One that has already started is ENDED today:
 * `endsOn` moves rather than a second "is it live" flag being set, so one date predicate
 * answers "does this apply" everywhere — in SQL, in the pure module, and in the browser — and
 * nothing can disagree with the dates.
 *
 * TODAY, NOT YESTERDAY. Sessions already run today were quoted the promotional price when they
 * were booked, and taking it back from somebody who has finished treating a client is not a
 * defensible way to correct a mistake. The button says so.
 *
 * One that has NOT started is deleted outright. Moving its end date below its start would break
 * `rental_promotions_dates_ordered`, and rightly — a promotion nobody was ever quoted has no
 * history worth keeping, so cancelling it is the honest shape rather than leaving a row that
 * ran for no days.
 */
export async function endPromotionNow(id: string, adminId: string): Promise<EndResult> {
  const today = todayInDenver()

  const cancelled = await db
    .delete(rentalPromotions)
    .where(and(eq(rentalPromotions.id, id), gte(rentalPromotions.startsOn, today)))
    .returning({ id: rentalPromotions.id })

  if (cancelled.length > 0) return 'cancelled'

  const ended = await db
    .update(rentalPromotions)
    .set({ endsOn: today, endedAt: new Date(), endedBy: adminId })
    .where(and(eq(rentalPromotions.id, id), gte(rentalPromotions.endsOn, today)))
    .returning({ id: rentalPromotions.id })

  return ended.length > 0 ? 'ended' : 'not_running'
}
