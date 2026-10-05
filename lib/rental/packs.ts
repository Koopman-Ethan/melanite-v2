import 'server-only'

import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providerPackRedemptions, providerPacks } from '@/lib/db/schema'
import { tierByKey, tierForService } from '@/lib/rental-fees'

import { getLiveSchedule } from './schedule'

// Fee-free laser sessions a provider has been granted.
//
// NOT SOLD. Melanite published pack rates for about a fortnight and Keoni withdrew them on
// 3 October: packages are the provider's business to run with their own clients, and selling a
// discounted block of rental put Melanite back in the middle of a pricing decision it had just
// got out of. `purchasePack` is gone with the rates.
//
// What remains is the entitlement, which is a different thing and still needed: the cutover owes
// Karly the sessions her clients paid for under the old model, and the honest way to honour them
// is a balance of sessions she is not charged for rather than a special case in the billing path
// that somebody has to remember to remove. `scripts/cutover-grant-packs.ts` creates them.
//
// The mechanics are deliberately the same shape as a client package — a counter pair with a check
// constraint, plus an append-only redemption row per session spent — because that shape has
// already been debugged here. The comment in `app/app/packages/actions.ts` records what it cost
// to learn: reading a count early and acting on it later handed out a free treatment.
//
// Two rules carry over, and both matter more here than they look:
//
//   CLAIM LATE, CLAIM ATOMICALLY. The claim is one statement, and the booking path must take it
//   immediately before inserting the booking — never while validating. Every early return is a
//   path where nothing was booked, and a session claimed before one is a session a provider paid
//   for and lost to a mistyped time.
//
//   A VOIDED REDEMPTION IS NOT A DELETED ONE. Returning a session voids the row and decrements the
//   counter in a single statement, gated on `voided_at IS NULL` so a double cancel cannot hand
//   back two sessions for one appointment.

/** A session taken out of a pack but not yet attached to a booking.
 *
 *  Exists because the booking row does not yet have an id when the session is claimed. Holding one
 *  of these means the counter has already moved: either `recordPackRedemption` or
 *  `releasePackSession` must follow, or the provider is down a session they never used. */
export interface PackClaim {
  packId: string
  tierKey: string
  /** 1-based — "session 4 of 6". */
  sessionIndex: number
  sessionsTotal: number
}

export interface PackBalance {
  tierKey: string
  /** From `RENTAL_TIERS`, or the raw key if the schedule no longer knows it. */
  label: string
  sessionsRemaining: number
  sessionsTotal: number
  /** What one session of this tier would otherwise cost, for "you are saving" copy. */
  singleCents: number | null
}

/**
 * Takes one session out of the oldest grant that still has one.
 *
 * Returns null when the provider has no grant for this service's tier, or none with a session left
 * — which is not an error, it is the ordinary case: the booking gets charged the fee instead.
 *
 * Oldest first, so a pack bought in March is spent before one bought in June. The alternative
 * leaves the old pack to rot while the new one is spent, and the provider finds out when the pack
 * they bought first is the one still holding sessions.
 */
export async function claimPackSession(
  providerId: string,
  serviceName: string,
): Promise<PackClaim | null> {
  const tier = tierForService(serviceName)
  if (!tier) return null

  // One statement. The inner SELECT ... FOR UPDATE is what makes the count safe: a second claim
  // racing this one blocks on the row, then re-evaluates `sessions_used < sessions_total` against
  // the committed value rather than the one it read before waiting. Concurrent claims on the last
  // session therefore serialise, and the loser sees no row rather than overdrawing.
  //
  // `provider_packs_sessions_used` is the backstop. If this logic is ever wrong the update fails
  // loudly instead of quietly granting a session nobody bought.
  const claimed = await db.execute<{
    id: string
    tier_key: string
    sessions_used: number
    sessions_total: number
  }>(sql`
    UPDATE provider_packs
       SET sessions_used = sessions_used + 1
     WHERE id = (
       SELECT id FROM provider_packs
        WHERE provider_id = ${providerId}::uuid
          AND tier_key = ${tier.key}
          AND sessions_used < sessions_total
        ORDER BY purchased_at NULLS LAST, created_at
        LIMIT 1
        FOR UPDATE
     )
    RETURNING id, tier_key, sessions_used, sessions_total
  `)

  const row = claimed.rows?.[0]
  if (!row) return null

  return {
    packId: row.id,
    tierKey: row.tier_key,
    sessionIndex: Number(row.sessions_used),
    sessionsTotal: Number(row.sessions_total),
  }
}

/** Attaches a claimed session to the booking it was spent on. */
export async function recordPackRedemption(claim: PackClaim, bookingId: string): Promise<void> {
  await db.insert(providerPackRedemptions).values({
    providerPackId: claim.packId,
    bookingId,
    sessionIndex: claim.sessionIndex,
  })
}

/** Puts a claimed session back when the booking did not happen after all.
 *
 *  The compensating half of `claimPackSession`, for the window between claiming and inserting the
 *  booking — a slot collision, or any other failure in between. `greatest(…, 0)` matches the
 *  client-package release: a counter that can go negative is worse than one that stops. */
export async function releasePackSession(claim: PackClaim): Promise<void> {
  await db
    .update(providerPacks)
    .set({ sessionsUsed: sql`greatest(${providerPacks.sessionsUsed} - 1, 0)` })
    .where(eq(providerPacks.id, claim.packId))
}

/**
 * Returns the session a cancelled booking spent.
 *
 * One statement with a CTE rather than a transaction — the neon-http driver has no interactive
 * transactions, which `app/app/appointments/actions.ts` documents at length after the package
 * version of this silently did nothing for weeks.
 *
 * `voided_at IS NULL` is the gate: the decrement reads from the CTE, so a second call voids
 * nothing and therefore gives nothing back. Returns true when a session was actually returned.
 */
export async function returnPackSession(bookingId: string): Promise<boolean> {
  const undone = await db.execute<{ id: string }>(sql`
    WITH voided AS (
      UPDATE provider_pack_redemptions SET voided_at = now()
       WHERE booking_id = ${bookingId}::uuid AND voided_at IS NULL
      RETURNING id, provider_pack_id
    ), returned AS (
      UPDATE provider_packs p
         SET sessions_used = greatest(p.sessions_used - 1, 0)
        FROM voided v
       WHERE p.id = v.provider_pack_id
      RETURNING p.id
    )
    SELECT id FROM voided
  `)

  return (undone.rows?.length ?? 0) > 0
}

/** Every pack a provider is still holding sessions on. */
export async function packBalancesFor(providerId: string): Promise<PackBalance[]> {
  const rows = await db
    .select({
      tierKey: providerPacks.tierKey,
      remaining: sql<number>`sum(${providerPacks.sessionsTotal} - ${providerPacks.sessionsUsed})::int`,
      total: sql<number>`sum(${providerPacks.sessionsTotal})::int`,
    })
    .from(providerPacks)
    .where(
      and(
        eq(providerPacks.providerId, providerId),
        sql`${providerPacks.sessionsUsed} < ${providerPacks.sessionsTotal}`,
      ),
    )
    .groupBy(providerPacks.tierKey)

  const schedule = await getLiveSchedule()

  return rows.map((r) => {
    const tier = tierByKey(r.tierKey)
    return {
      tierKey: r.tierKey,
      // Falling back to the raw key rather than hiding the row: a grant whose tier left the
      // schedule is still sessions somebody is owed, and it must not vanish from their balance.
      label: tier?.label ?? r.tierKey,
      sessionsRemaining: Number(r.remaining),
      sessionsTotal: Number(r.total),
      // The live fee, so "rent you won't be charged" is worth what it would cost today rather
      // than what it cost when the code was written.
      singleCents: schedule.byTier.get(r.tierKey)?.singleCents ?? tier?.singleCents ?? null,
    }
  })
}

/**
 * Grants a pack without taking any money.
 *
 * For comped sessions — the cutover owes Karly the pre-paid sessions her clients already bought,
 * and the honest way to honour them is a pack she does not pay for rather than a special case in
 * the billing path. `note` is required by a check constraint, because a free balance with no
 * explanation is indistinguishable from a bug.
 *
 * No ledger row. Nothing was paid, and a zero-value entry would make "what did the laser earn"
 * read as though it earned nothing on those sessions rather than nothing being charged for them.
 */
export async function grantPack(input: {
  providerId: string
  tierKey: string
  sessions: number
  note: string
}): Promise<{ packId: string } | { error: string }> {
  if (!tierByKey(input.tierKey)) return { error: `No rental tier named ${input.tierKey}.` }
  if (input.sessions < 1) return { error: 'A pack needs at least one session.' }
  if (!input.note.trim()) return { error: 'A comped pack needs a note saying why.' }

  const [pack] = await db
    .insert(providerPacks)
    .values({
      providerId: input.providerId,
      tierKey: input.tierKey,
      sessionsTotal: input.sessions,
      amountPaid: '0.00',
      purchasedAt: new Date(),
      note: input.note,
    })
    .returning({ id: providerPacks.id })

  return { packId: pack.id }
}
