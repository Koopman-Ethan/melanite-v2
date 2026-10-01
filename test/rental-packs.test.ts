import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  claimPackSession,
  grantPack,
  packBalancesFor,
  purchasePack,
  recordPackRedemption,
  releasePackSession,
  returnPackSession,
} from '@/lib/rental/packs'
import { tierByKey } from '@/lib/rental-fees'

// Laser time bought in advance.
//
// A pack is a balance of something valuable, so the tests that matter are the ones about it
// changing by exactly one: a session spent twice is a session the provider paid for and lost, and
// a session returned twice is one Melanite gave away. Both are silent — nothing throws, the
// counter just reads wrong a month later.
//
// Everything here drives the real functions against real rows. The database constraints are
// tested by trying to violate them, because a check constraint nobody has attempted to break is a
// comment with a syntax error.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ PACKS ${Date.now()}`
let providerId = ''
let providerServiceId = ''
const bookingIds: string[] = []

/** The laser is one shared resource behind an exclusion constraint and dev carries real
 *  appointments, so walk back until a slot is free rather than failing on whoever was booked. */
async function book(): Promise<string> {
  for (let back = 500; back < 800; back += 2) {
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, client_name, original_price, price, payment_source,
            duration_mins, start_time, end_time, status)
         VALUES ($1, $2, $3, '0.00', '0.00', 'comped', 60,
                 now() - ($4 || ' hours')::interval, now() - ($5 || ' hours')::interval, 'completed')
         RETURNING id`,
        [providerId, providerServiceId, TAG, String(back), String(back - 1)],
      )) as { id: string }[]
      bookingIds.push(rows[0].id)
      return rows[0].id
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }
  throw new Error('could not place a fixture booking')
}

/** Packs made by a test, cleaned up by id rather than by provider — dev may hold real ones. */
const packIds: string[] = []

async function grant(tierKey: string, sessions: number): Promise<string> {
  const out = await grantPack({ providerId, tierKey, sessions, note: TAG })
  if ('error' in out) throw new Error(out.error)
  packIds.push(out.packId)
  return out.packId
}

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers WHERE revenue_model = 'split' AND booking_enabled LIMIT 1`,
  )) as { id: string }[]
  providerId = prov.id

  const [svc] = (await sql.query(
    `SELECT id FROM services WHERE name = 'Laser Hair Removal — Chin' AND active`,
  )) as { id: string }[]

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [providerId, svc.id],
  )) as { id: string }[]

  providerServiceId = existing[0]
    ? existing[0].id
    : (
        (await sql.query(
          `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
           VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
          [providerId, svc.id],
        )) as { id: string }[]
      )[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM provider_pack_redemptions WHERE booking_id = ANY($1::uuid[])`, [
    bookingIds,
  ])
  await sql.query(`DELETE FROM provider_packs WHERE id = ANY($1::uuid[])`, [packIds])
  await sql.query(`DELETE FROM bookings WHERE client_name = $1`, [TAG])
})

describe('spending a pack', () => {
  it('draws down one session at a time and then stops', async () => {
    // "Laser Hair Removal — Chin" is lhr_xs. Three sessions, so the fourth claim must find
    // nothing rather than lending against a pack that is spent.
    await grant('lhr_xs', 3)

    const first = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    const second = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    const third = await claimPackSession(providerId, 'Laser Hair Removal — Chin')

    expect(first?.sessionIndex).toBe(1)
    expect(second?.sessionIndex).toBe(2)
    expect(third?.sessionIndex).toBe(3)
    expect(third?.sessionsTotal).toBe(3)

    expect(await claimPackSession(providerId, 'Laser Hair Removal — Chin')).toBeNull()
  })

  it('returns null for a service the provider holds no pack for', async () => {
    // Not an error. It means the booking path charges the single-session fee instead, which is
    // the common case and must not look like a failure.
    expect(await claimPackSession(providerId, 'Tattoo Removal (Large)')).toBeNull()
  })

  it('returns null for a service the schedule does not price', async () => {
    expect(await claimPackSession(providerId, 'Carbon Laser Treatment')).toBeNull()
  })

  it('spends the oldest pack first', async () => {
    // Otherwise the pack bought first is the one left holding sessions, and the provider finds
    // out rather than being told.
    const older = await grant('lhr_medium', 1)
    const newer = await grant('lhr_medium', 1)

    // Both were granted with purchased_at = now(); force an order rather than relying on clock
    // resolution to separate two inserts a millisecond apart.
    await sql.query(`UPDATE provider_packs SET purchased_at = now() - interval '30 days' WHERE id = $1`, [
      older,
    ])

    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Brazilian')
    expect(claim?.packId).toBe(older)

    const next = await claimPackSession(providerId, 'Laser Hair Removal — Brazilian')
    expect(next?.packId).toBe(newer)
  })
})

describe('putting a session back', () => {
  it('releases a claim that never became a booking', async () => {
    // The compensating path: the slot collided, or anything else failed between claiming and
    // inserting. Without it the provider silently loses a session to a failed booking.
    await grant('lhr_small', 2)

    // Asserted against whichever pack the claim actually came from, not the one granted here.
    // Oldest-first means a pack already in the database wins, and this is about the counter
    // moving back by one — not about which pack moved.
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Underarms')
    expect(claim).not.toBeNull()
    const used = Number(claim!.sessionIndex)

    await releasePackSession(claim!)

    const [row] = (await sql.query(`SELECT sessions_used FROM provider_packs WHERE id = $1`, [
      claim!.packId,
    ])) as { sessions_used: number }[]
    expect(Number(row.sessions_used)).toBe(used - 1)
  })

  it('returns a redeemed session when the booking is cancelled, exactly once', async () => {
    // The double-cancel case. A package that grows when you poke it is the failure the client
    // version of this had, and the gate is `voided_at IS NULL`.
    await grant('lhr_large', 2)
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Full Legs')
    const bookingId = await book()
    await recordPackRedemption(claim!, bookingId)
    const used = Number(claim!.sessionIndex)

    expect(await returnPackSession(bookingId)).toBe(true)
    // The second call is the one that matters: a pack that grows when you poke it is the exact
    // failure the client-package version of this had.
    expect(await returnPackSession(bookingId)).toBe(false)

    const [row] = (await sql.query(`SELECT sessions_used FROM provider_packs WHERE id = $1`, [
      claim!.packId,
    ])) as { sessions_used: number }[]
    expect(Number(row.sessions_used)).toBe(used - 1)
  })

  it('reports nothing to return for a booking that never spent a session', async () => {
    const bookingId = await book()
    expect(await returnPackSession(bookingId)).toBe(false)
  })

  it('keeps the voided redemption row', async () => {
    // Append-only. "This session was spent and then given back" is a different fact from "this
    // session was never spent", and only one of them survives a delete.
    const rows = (await sql.query(
      `SELECT count(*)::int AS n FROM provider_pack_redemptions
        WHERE booking_id = ANY($1::uuid[]) AND voided_at IS NOT NULL`,
      [bookingIds],
    )) as { n: number }[]
    expect(rows[0].n).toBeGreaterThan(0)
  })
})

describe('what the database refuses', () => {
  it('will not let a pack be overdrawn', async () => {
    const packId = await grant('lhr_xs', 1)
    await expect(
      sql.query(`UPDATE provider_packs SET sessions_used = 2 WHERE id = $1`, [packId]),
    ).rejects.toThrow()
  })

  it('will not let a counter go negative', async () => {
    const packId = await grant('lhr_xs', 1)
    await expect(
      sql.query(`UPDATE provider_packs SET sessions_used = -1 WHERE id = $1`, [packId]),
    ).rejects.toThrow()
  })

  it('will not accept a free pack with no explanation', async () => {
    // A zero-cost balance with nothing recording who granted it or why is indistinguishable from
    // a bug, and the cutover creates several at once.
    await expect(
      sql.query(
        `INSERT INTO provider_packs (provider_id, tier_key, sessions_total, amount_paid)
         VALUES ($1, 'lhr_xs', 6, '0.00')`,
        [providerId],
      ),
    ).rejects.toThrow()
  })

  it('will not accept an empty pack', async () => {
    await expect(
      sql.query(
        `INSERT INTO provider_packs (provider_id, tier_key, sessions_total, amount_paid, note)
         VALUES ($1, 'lhr_xs', 0, '0.00', 'zero')`,
        [providerId],
      ),
    ).rejects.toThrow()
  })

  it('will not let one booking spend two sessions', async () => {
    // The unique index on booking_id. Without it a retried booking path draws a second session
    // and nothing anywhere says so.
    // Which pack the sessions come from is not the point here, and asserting it would only
    // couple this to whatever earlier tests left lying around.
    await grant('lhr_xs', 2)
    const bookingId = await book()
    const claim = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    await recordPackRedemption(claim!, bookingId)

    const second = await claimPackSession(providerId, 'Laser Hair Removal — Chin')
    await expect(recordPackRedemption(second!, bookingId)).rejects.toThrow()
  })
})

describe('what a provider is holding', () => {
  it('counts only packs with sessions left', async () => {
    const spent = await grant('tattoo_xxs', 1)
    const claim = await claimPackSession(providerId, 'Tattoo Removal (XXSmall)')
    expect(claim?.packId).toBe(spent)

    const balances = await packBalancesFor(providerId)
    expect(balances.find((b) => b.tierKey === 'tattoo_xxs')).toBeUndefined()

    await grant('tattoo_xxs', 4)
    const after = await packBalancesFor(providerId)
    const tattoo = after.find((b) => b.tierKey === 'tattoo_xxs')
    expect(tattoo?.sessionsRemaining).toBe(4)
    expect(tattoo?.singleCents).toBe(5000)
    expect(tattoo?.label).toContain('Tattoo')
  })
})

describe('granting a pack', () => {
  it('refuses a tier the schedule does not have', async () => {
    const out = await grantPack({
      providerId,
      tierKey: 'lhr_enormous',
      sessions: 6,
      note: TAG,
    })
    expect(out).toHaveProperty('error')
  })

  it('refuses a free pack with no note, before the database has to', async () => {
    const out = await grantPack({ providerId, tierKey: 'lhr_xs', sessions: 6, note: '  ' })
    expect(out).toHaveProperty('error')
  })
})

describe('selling a pack, refusals before Stripe', () => {
  it('refuses a tier that does not exist', async () => {
    const out = await purchasePack({ providerId, tierKey: 'nonsense', sessions: 6 })
    expect(out).toHaveProperty('error')
  })

  it('refuses a block size that tier does not publish', async () => {
    // Hair removal sells 6 and 8. A 5-pack has no published price, and inventing one by
    // multiplying the single rate would sell a pack at no discount.
    const out = await purchasePack({ providerId, tierKey: 'lhr_xs', sessions: 5 })
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/not sold in blocks of 5/i)
  })

  it('refuses a provider with no card on file', async () => {
    const out = await purchasePack({ providerId, tierKey: 'lhr_xs', sessions: 6 })
    expect(out).toHaveProperty('error')
    if ('error' in out) expect(out.error).toMatch(/no card on file/i)
  })
})

describe('tier keys stored in the database', () => {
  it('all still resolve against the schedule', async () => {
    // `tier_key` is not a foreign key, because the fee schedule lives in code — see the header of
    // `lib/rental-fees.ts`. This is the check that buys back what the foreign key would have
    // given: a renamed tier leaves packs pointing at nothing, and the provider's balance quietly
    // loses its label and its price.
    const rows = (await sql.query(
      `SELECT DISTINCT tier_key FROM provider_packs`,
    )) as { tier_key: string }[]

    const orphaned = rows.map((r) => r.tier_key).filter((k) => !tierByKey(k))

    expect(
      orphaned,
      `provider_packs holds tier keys the schedule no longer knows:\n  ${orphaned.join('\n  ')}\n` +
        'Renaming a tier means migrating the packs that were sold under the old key.',
    ).toEqual([])
  })
})
