import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { paysRentSql } from '@/lib/db/revenue-model'
import { CLOSEOUT_GRACE_HOURS } from '@/lib/end-of-use'

import { chargeRentalFee } from './charge'
import { feeForService } from './schedule'

// Taking the rent, after the session rather than at the booking.
//
// WHY THIS EXISTS AT ALL. Until 9 October the fee was taken the moment a provider reserved a
// slot, and a declined card failed the booking — self-enforcing, nothing to chase. Keoni
// withdrew that after the demo: providers are frequently not paid by their own client until the
// work is done, so charging them to hold a slot is the wrong way round for the industry.
//
// So Melanite now extends credit on every session, and this file is the thing that collects.
//
// THE DESIGN PROPERTY THAT MATTERS: eligibility is a predicate over database state and `now()`,
// never over when this ran. A session becomes billable twelve hours after it ends and STAYS
// billable until it is charged, waived, or decided by a human. Nothing is scheduled per booking.
//
// That is deliberate, and it is the answer to the obvious objection about cron. Ethan had
// watched the GitHub Actions nightly refresh drift and did not want billing hanging off a timer.
// It does not. A run that is late, duplicated, skipped entirely, or killed half way through
// changes WHEN money lands and never WHETHER it does:
//
//   late      — the rows are still eligible; the next run takes them
//   doubled   — every item is idempotent three times over (see below)
//   skipped   — nothing expires, because the predicate has no upper time bound
//   timed out — what was charged stays charged; the rest is picked up next time
//
// And four separate things drain it, so no single mechanism is load-bearing: the evening digest
// calls it, a cron route calls it, the admin page has a button, and an app page load triggers it
// opportunistically. The Vercel plan tier therefore changes latency only.
//
// IDEMPOTENCY IS AT THE ITEM, NOT THE RUN — the standing rule in `docs/decisions.md` for any
// scheduled job here. There is deliberately no run-level key gating this: the unit of work is a
// booking, not a day. Three independent layers protect one booking from paying twice: the
// ledger `NOT EXISTS` guard inside `chargeRentalFee`, the Stripe idempotency key
// `rental-fee:<bookingId>`, and the partial unique index on `stripe_payment_intent_id`. The
// crash window (Stripe took it, the ledger insert did not) self-heals: the next sweep re-sends
// the same key, Stripe replays the original intent rather than charging again, and the ledger
// row gets written.

/** How many attempts before the sweep stops trying and leaves it to a human.
 *
 *  A dead card would otherwise produce a Stripe decline on every run forever — and, for a
 *  provider with receipts switched on, an email each time. Five is enough to ride out a
 *  temporary hold and few enough to stop being noise. */
const MAX_ATTEMPTS = 5

/** How long to wait after a failure before trying that booking again.
 *
 *  Longer than the gap between runs on purpose. Without it the sweep would retry the same dead
 *  card every hour and burn through MAX_ATTEMPTS before the provider has had a chance to notice
 *  the email and update anything. */
const RETRY_AFTER_HOURS = 20

/** Stop before the serverless function is killed, so a long backlog is drained across several
 *  runs rather than losing whatever was in flight. `maxDuration` on the route is 60s. */
const TIME_BUDGET_MS = 45_000

export interface SettleResult {
  /** Sessions charged on this run. */
  charged: number
  /** Cents taken, for the digest line. */
  chargedCents: number
  /** Tried and refused — a declined card, or Stripe refusing Melanite. */
  failed: number
  /** Deliberately not charged: Melanite's own, a pack session, already billed. */
  skipped: number
  /** Still eligible and not attempted, because the batch or the clock ran out. */
  remaining: number
  /** Past due, and deliberately NOT attempted on this run: the card already declined and is
   *  inside its back-off, or it has used up its attempts.
   *
   *  Reported because "nothing was charged" and "nothing is owed" are different facts, and a
   *  sweep that conflated them told Keoni every session was settled while one sat failing. */
  deferred: number
}

interface Due extends Record<string, unknown> {
  id: string
}

/**
 * Charges every session whose rent is due.
 *
 * Safe to call from anywhere, as often as anybody likes. Never throws for a booking it cannot
 * charge — a single bad row must not stop the rest of the batch, which is the whole point of
 * draining a queue rather than processing an event.
 */
export async function settleDueRent(options: { limit?: number } = {}): Promise<SettleResult> {
  const limit = options.limit ?? 25
  const startedAt = Date.now()

  const { rows } = await db.execute<Due>(sql`
    SELECT b.id
      FROM bookings b
      JOIN providers p ON p.id = b.provider_id
     WHERE b.payment_source = 'rental'
       AND ${paysRentSql(sql`p.revenue_model`)}
       -- Not a no-show and not cancelled. Those did not happen, so the sweep must never touch
       -- them: whether the provider owes anything is Keoni's call, and she makes it in the
       -- queue. A sweep that billed them would be answering her question for her, always the
       -- same way, which is exactly the behaviour she removed on 7 October.
       AND b.status IN ('upcoming', 'completed')
       -- Keyed on TIME, never on the 'completed' status. markCompleted has no confirmation
       -- dialog and no consumer, and the digest already prints "Still marked upcoming" because
       -- bookings rot there. Billing cannot depend on a button nobody presses.
       AND b.end_time < now() - ${sql.raw(`interval '${CLOSEOUT_GRACE_HOURS} hours'`)}
       AND b.rent_waived_at IS NULL
       AND b.rent_charge_attempts < ${MAX_ATTEMPTS}
       AND (
         b.rent_charge_failed_at IS NULL
         OR b.rent_charge_failed_at < now() - ${sql.raw(`interval '${RETRY_AFTER_HOURS} hours'`)}
       )
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries le
          WHERE le.subject_type = 'booking' AND le.subject_id = b.id
            AND le.source = 'rental_fee' AND le.entry_type = 'purchase'
       )
       AND NOT EXISTS (
         SELECT 1 FROM provider_pack_redemptions r
          WHERE r.booking_id = b.id AND r.voided_at IS NULL
       )
     ORDER BY b.end_time
     LIMIT ${limit}
  `)

  const due = rows ?? []

  // Past due, unsettled, and excluded above by the back-off or the attempt cap. Counted
  // separately so the caller can say "nothing could be taken" rather than "nothing is owed".
  const deferredRows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM bookings b
      JOIN providers p ON p.id = b.provider_id
     WHERE b.payment_source = 'rental'
       AND ${paysRentSql(sql`p.revenue_model`)}
       AND b.status IN ('upcoming', 'completed')
       AND b.end_time < now() - ${sql.raw(`interval '${CLOSEOUT_GRACE_HOURS} hours'`)}
       AND b.rent_waived_at IS NULL
       AND b.rent_charge_failed_at IS NOT NULL
       AND (
         b.rent_charge_attempts >= ${MAX_ATTEMPTS}
         OR b.rent_charge_failed_at >= now() - ${sql.raw(`interval '${RETRY_AFTER_HOURS} hours'`)}
       )
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries le
          WHERE le.subject_type = 'booking' AND le.subject_id = b.id
            AND le.source = 'rental_fee' AND le.entry_type = 'purchase'
       )
  `)

  const result: SettleResult = {
    charged: 0,
    chargedCents: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    deferred: deferredRows.rows?.[0]?.n ?? 0,
  }

  for (const [i, row] of due.entries()) {
    // SEQUENTIAL, not parallel. Each iteration is an off-session charge against a saved card;
    // firing them at once invites Stripe's rate limiter and makes a mid-flight timeout
    // impossible to reason about afterwards.
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      result.remaining = due.length - i
      break
    }

    try {
      const out = await chargeRentalFee(row.id)
      if ('charged' in out) {
        result.charged += 1
        result.chargedCents += out.charged.amountCents
      } else if ('error' in out) {
        result.failed += 1
      } else {
        result.skipped += 1
      }
    } catch (err) {
      // `chargeRentalFee` records its own failures; this is for anything it did not catch — a
      // dropped connection, a bug. Counted and stepped over, because one unbillable session
      // must not stop the other twenty-four.
      result.failed += 1
      console.error(`[settle] booking ${row.id} threw rather than returning`, err)
    }
  }

  // A full batch means there is more behind it. Reported so the digest and the route can say so
  // out loud rather than looking like they finished.
  if (result.remaining === 0 && due.length === limit) result.remaining = -1

  return result
}

export interface UnsettledRent {
  /** Charges that were attempted and refused, and not waived. */
  failedCount: number
  /** Cents on those failures, priced at today's schedule. */
  failedCents: number
  /** How long the oldest has been failing, in whole days. */
  oldestDays: number
}

/**
 * What a provider owes that Melanite tried and failed to take.
 *
 * FAILED ONLY, deliberately — not merely-unswept. The booking gate is built on this, and
 * blocking somebody because last night's sweep ran late would shut the calendar every morning
 * the cron drifted: it would convert a latency problem into a correctness problem and throw away
 * the one property this whole design is built around.
 *
 * Priced in TypeScript rather than in the query. A service's fee is its TIER's fee, and the
 * service-name-to-tier map lives in `lib/rental-fees.ts` because the catalogue is truncated and
 * reloaded by the ETL — so there is no key in the database to join on. `feeForService` is the
 * one place that knows, and it is the same function the charge itself uses.
 */
export async function unsettledRent(providerId: string): Promise<UnsettledRent> {
  const { rows } = await db.execute<{ service_name: string; failed_at: string }>(sql`
    SELECT s.name AS service_name, b.rent_charge_failed_at::text AS failed_at
      FROM bookings b
      JOIN provider_services ps ON ps.id = b.provider_service_id
      JOIN services s           ON s.id = ps.service_id
     WHERE b.provider_id = ${providerId}::uuid
       AND b.payment_source = 'rental'
       AND b.rent_charge_failed_at IS NOT NULL
       AND b.rent_waived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries le
          WHERE le.subject_type = 'booking' AND le.subject_id = b.id
            AND le.source = 'rental_fee' AND le.entry_type = 'purchase'
       )
     ORDER BY b.rent_charge_failed_at
  `)

  const failures = rows ?? []
  if (failures.length === 0) return { failedCount: 0, failedCents: 0, oldestDays: 0 }

  let cents = 0
  for (const f of failures) {
    cents += (await feeForService(f.service_name)) ?? 0
  }

  const oldest = new Date(failures[0].failed_at)

  return {
    failedCount: failures.length,
    failedCents: cents,
    oldestDays: Math.max(Math.floor((Date.now() - oldest.getTime()) / 86_400_000), 0),
  }
}

/** The lease row's identity. One row, reused forever, holding the last time a sweep ran.
 *
 *  `webhook_events` rather than a new table: it already exists to answer "did this thing happen",
 *  already has a unique index on `event_id`, and the digest already keeps its once-per-day key
 *  there. A table for one row would be ceremony. */
const SWEEP_LEASE = 'settle-rent:opportunistic'

/** How stale the last sweep must be before a page load triggers another. */
const LEASE_HOURS = 1

/**
 * Sweeps, but only if nothing has swept in the last hour.
 *
 * WHY A PAGE LOAD COLLECTS RENT. Vercel Cron is best effort, and on the Hobby tier both cron
 * slots are already spent on the evening digest — so without this, a silently broken schedule
 * could stall billing for days with nothing to show it. A provider opening the app is the most
 * reliable clock Melanite has.
 *
 * THE LEASE IS CLAIMED ATOMICALLY, in one UPDATE, so of all the instances serving requests in a
 * given hour exactly one proceeds. Not for correctness — every item is idempotent, and twenty
 * concurrent sweeps would still charge each session once — but because twenty concurrent sweeps
 * would hammer Stripe to do one sweep's work.
 *
 * Never throws. It runs after the response has been sent, so there is nobody to tell; a failure
 * here must not turn into an unhandled rejection in a log somebody is reading for real problems.
 */
export async function maybeSettleRent(): Promise<SettleResult | null> {
  try {
    // Create the row the first time, then never again.
    await db.execute(sql`
      INSERT INTO webhook_events (destination, event_type, event_id, signature_verified,
                                  processed_at)
      VALUES ('cron', 'settle-rent', ${SWEEP_LEASE}, true, now() - interval '1 year')
      ON CONFLICT (event_id) DO NOTHING
    `)

    // Claim it. The WHERE is the lease: a second instance in the same hour updates no rows and
    // gets nothing back.
    const claim = await db.execute<{ event_id: string }>(sql`
      UPDATE webhook_events SET processed_at = now()
       WHERE event_id = ${SWEEP_LEASE}
         AND processed_at < now() - ${sql.raw(`interval '${LEASE_HOURS} hours'`)}
      RETURNING event_id
    `)

    if ((claim.rows?.length ?? 0) === 0) return null

    const result = await settleDueRent()

    if (result.charged > 0 || result.failed > 0) {
      console.log(
        `[settle] opportunistic sweep: ${result.charged} charged, ${result.failed} failed`,
      )
    }

    return result
  } catch (err) {
    console.error('[settle] the opportunistic sweep failed', err)
    return null
  }
}
