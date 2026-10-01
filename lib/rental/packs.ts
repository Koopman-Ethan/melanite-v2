import 'server-only'

import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { providerPackRedemptions, providerPacks, providers } from '@/lib/db/schema'
import { toMoney } from '@/lib/money'
import { tierByKey, tierForService } from '@/lib/rental-fees'
import { StripeApiError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'

// Laser time bought in advance.
//
// A provider pre-buys sessions in a tier at the pack rate and spends them as they book. It is the
// same idea as a client package and the mechanics are deliberately the same shape — a counter pair
// with a check constraint, plus an append-only redemption row per session spent — because that
// shape has already been debugged here. The comment in `app/app/packages/actions.ts` records what
// it cost to learn: reading a count early and acting on it later handed out a free treatment.
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
 * Takes one session out of the oldest pack that still has one.
 *
 * Returns null when the provider has no pack for this service's tier, or none with a session left
 * — which is not an error, it just means the booking gets charged the single-session fee instead.
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

  return rows.map((r) => {
    const tier = tierByKey(r.tierKey)
    return {
      tierKey: r.tierKey,
      // Falling back to the raw key rather than hiding the row: a pack whose tier left the
      // schedule is still sessions somebody paid for, and it must not vanish from their balance.
      label: tier?.label ?? r.tierKey,
      sessionsRemaining: Number(r.remaining),
      sessionsTotal: Number(r.total),
      singleCents: tier?.fee.singleCents ?? null,
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

/**
 * Sells a provider a pack at the published pack rate.
 *
 * Same discipline as `lib/rental/charge.ts`: every refusal happens before the Stripe call, so the
 * refusals are testable against real rows without a network.
 *
 * The pack and its ledger row are written in ONE statement after the charge succeeds. Writing the
 * pack first would mean a declined card leaves free sessions behind; writing them separately would
 * mean a failure between the two leaves money taken with no pack to show for it. A CTE gives both
 * or neither without needing a transaction the driver does not have.
 */
export async function purchasePack(input: {
  providerId: string
  tierKey: string
  sessions: number
}): Promise<{ packId: string; amountCents: number } | { error: string }> {
  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  const tier = tierByKey(input.tierKey)
  if (!tier) return { error: `No rental tier named ${input.tierKey}.` }

  const pack = tier.fee.packs.find((p) => p.sessions === input.sessions)
  if (!pack) {
    // Never interpolate a price for an unpublished block size. Multiplying the single rate would
    // sell a "pack" at no discount; scaling the nearest one would invent a rate nobody set.
    return { error: `${tier.label} is not sold in blocks of ${input.sessions}.` }
  }

  const [provider] = await db
    .select({
      firstName: providers.firstName,
      lastName: providers.lastName,
      revenueModel: providers.revenueModel,
      customerId: providers.stripeBillingCustomerId,
      paymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1)

  if (!provider) return { error: 'That provider does not exist.' }
  if (provider.revenueModel === 'house') {
    return { error: 'Melanite does not buy laser time from itself.' }
  }
  if (!provider.customerId || !provider.paymentMethodId) {
    return {
      error: `${provider.firstName} ${provider.lastName} has no card on file for rental fees.`,
    }
  }

  // Generated up front so it can key the idempotent charge as well as the row. A retried purchase
  // therefore reaches the same Stripe intent rather than buying a second pack.
  const packId = crypto.randomUUID()

  let intentId: string
  try {
    const intent = await stripePost<{ id: string }>(
      '/payment_intents',
      {
        amount: pack.cents,
        currency: 'usd',
        customer: provider.customerId,
        payment_method: provider.paymentMethodId,
        off_session: true,
        confirm: true,
        description: `Laser rental pack — ${input.sessions} × ${tier.label}`,
        metadata: {
          type: 'rental_pack',
          pack_id: packId,
          provider_id: input.providerId,
          tier_key: tier.key,
        },
      },
      { idempotencyKey: `rental-pack:${packId}` },
    )
    intentId = intent.id
  } catch (err) {
    if (err instanceof StripeApiError) {
      return { error: `The card was declined: ${err.message}` }
    }
    throw err
  }

  await db.execute(sql`
    WITH p AS (
      INSERT INTO provider_packs
        (id, provider_id, tier_key, sessions_total, amount_paid, purchased_at,
         stripe_payment_intent_id)
      VALUES (${packId}::uuid, ${input.providerId}::uuid, ${tier.key}, ${input.sessions},
              ${toMoney(pack.cents)}, now(), ${intentId})
      RETURNING id, provider_id
    )
    INSERT INTO ledger_entries
      (source, payer, entry_type, subject_type, subject_id, provider_id,
       gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
       stripe_payment_intent_id, payout_status)
    SELECT 'rental_fee', 'provider', 'purchase', 'provider_pack', p.id, p.provider_id,
           ${toMoney(pack.cents)}, '0.00', '0.00', ${toMoney(pack.cents)}, 'stripe',
           ${intentId}, 'paid'
      FROM p
  `)

  return { packId, amountCents: pack.cents }
}
