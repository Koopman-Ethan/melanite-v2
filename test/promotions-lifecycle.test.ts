import { afterAll, describe, expect, it } from 'vitest'
import { and, eq, like } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providers, rentalPromotions } from '@/lib/db/schema'
import { activePromotions, createPromotion, endPromotionNow } from '@/lib/rental/promotions'
import { todayInDenver } from '@/lib/validation'

// Stopping a promotion, against the real table.
//
// WHY NOT PURE. Ending one is two different writes chosen by a SQL predicate — delete a
// promotion nobody was ever quoted, stamp `ended_at` on one that is running — and the bug this
// file exists for lived entirely in that predicate. `starts_on >= today` reads as "has not
// started" and is wrong on exactly one day: the day it starts, when the promotion is live on
// the booking page quoting prices. Ending it then DELETED the row and the record of what
// people had been quoted along with it. Ending a promotion on its first day is how a mistake
// gets corrected, so that day is the common case.
//
// Pinned on a tier no service maps to, so a promotion existing mid-run cannot change a fee any
// other test is asserting against.

const TIER = 'zz_lifecycle_test'
const NAME = 'lifecycle test promotion'

function ymd(daysFromToday: number): string {
  const [y, m, d] = todayInDenver().split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d + daysFromToday))
  return at.toISOString().slice(0, 10)
}

async function adminId(): Promise<string> {
  const [who] = await db.select({ id: providers.id }).from(providers).limit(1)
  if (!who) throw new Error('no provider in dev — this test needs one')
  return who.id
}

async function make(startsOn: string, endsOn: string): Promise<string> {
  const { id } = await createPromotion(
    { name: NAME, tierKey: TIER, kind: 'percent', value: 10, startsOn, endsOn },
    await adminId(),
  )
  return id
}

const row = (id: string) =>
  db
    .select({
      endsOn: rentalPromotions.endsOn,
      endedAt: rentalPromotions.endedAt,
      endedBy: rentalPromotions.endedBy,
    })
    .from(rentalPromotions)
    .where(eq(rentalPromotions.id, id))
    .then((r) => r[0] ?? null)

afterAll(async () => {
  await db
    .delete(rentalPromotions)
    .where(and(eq(rentalPromotions.tierKey, TIER), like(rentalPromotions.name, `${NAME}%`)))
})

describe('ending a promotion that is running', () => {
  it('stamps it rather than deleting it, and leaves the window alone', async () => {
    const endsOn = ymd(10)
    const id = await make(todayInDenver(), endsOn)

    expect(await endPromotionNow(id, await adminId()), 'started today, so it ENDS').toBe('ended')

    const after = await row(id)
    expect(after, 'the row survives — it is the record of what people were quoted').not.toBeNull()
    expect(after?.endedAt, 'and carries when it stopped').not.toBeNull()
    expect(after?.endedBy, 'and who stopped it').not.toBeNull()
    expect(after?.endsOn, 'the advertised window is untouched').toBe(endsOn)
  })

  it('stops listing it as running', async () => {
    const id = await make(todayInDenver(), ymd(10))
    await endPromotionNow(id, await adminId())

    const listed = (await activePromotions()).map((p) => p.id)
    expect(listed, 'ended is not running, whatever its end date says').not.toContain(id)
  })

  it('refuses to end the same one twice', async () => {
    // A second press must not move `endedAt` forward — that would hand the promotion back to
    // every booking made between the two.
    const id = await make(todayInDenver(), ymd(10))
    await endPromotionNow(id, await adminId())

    expect(await endPromotionNow(id, await adminId())).toBe('not_running')
  })
})

describe('cancelling a promotion that has not started', () => {
  it('deletes it, because nobody was ever quoted it', async () => {
    const id = await make(ymd(1), ymd(10))

    expect(await endPromotionNow(id, await adminId()), 'starts tomorrow, so it CANCELS').toBe(
      'cancelled',
    )
    expect(await row(id), 'and leaves nothing to explain on a screen').toBeNull()
  })
})
