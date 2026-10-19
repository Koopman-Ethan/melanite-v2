import 'server-only'

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { ledgerEntries } from '@/lib/db/schema'
import { stripeGet, stripeWritesEnabled } from '@/lib/stripe/client'

// Replacing the predicted processing fee with what Stripe actually took, on every charge a
// provider pays: laser time, the room, and the membership plans.
//
// WHY THIS IS A SWEEP AND NOT PART OF THE CHARGE. The obvious version reads the fee off the
// PaymentIntent as it is created, with `expand[]=latest_charge.balance_transaction`. That was
// built first and it silently does not work: at the instant a charge is confirmed it has no
// balance transaction yet, so the field comes back null — and null is worse than an estimate,
// because on a revenue page it reads as "this one cost nothing to process". Reading the SAME
// intent back a minute later returns the fee sitting there, which is how the lag was found.
//
// So the charge stores its prediction and this corrects it afterwards.
//
// WHY THE CORRECTION MATTERS AT ALL. `platform_settings.stripe_fee_pct` is one number and
// Stripe's real rate is not: 2.9% + 30c on a domestic card, more on Amex, more on an
// international one, more again with currency conversion. Keoni prices the gross-up off that
// setting, so if nothing ever measures the truth she is tuning a number against a guess. The
// gap between predicted and actual is the whole point of recording both.
//
// IDEMPOTENT AND BOUNDED. It re-reads rows rather than tracking which have been corrected,
// because a flag is one more thing that can disagree with reality — and writing the same
// figure twice costs nothing. Bounded by date and by a row limit so it cannot turn into an
// unbounded walk of the ledger on a slow evening.

/** How far back to look. Stripe settles within minutes; a week is generous and keeps the sweep
 *  cheap even if it has not run for a few days. */
const LOOKBACK_DAYS = 7

/** Stripe calls cost a round trip each, so this is sized for an evening's worth of sessions
 *  rather than a backfill. A backlog drains over consecutive runs. */
const MAX_ROWS = 100

export interface ReconcileResult {
  checked: number
  /** Rows whose stored fee was wrong and has been replaced. */
  corrected: number
  /** Total cents the estimate was off by, signed. Positive means Melanite was over-recovering
   *  — the prediction was higher than the real cost — which is the direction to watch, because
   *  it is money taken from providers that Stripe did not charge. */
  driftCents: number
  /** Stripe had no balance transaction yet. Ordinary for a charge made seconds ago, and the
   *  reason this is a sweep rather than a one-shot. */
  pending: number
}

interface IntentWithFee {
  latest_charge?: { balance_transaction?: { fee?: number } | null } | null
}

/**
 * Corrects stored processing fees from Stripe, for recent provider charges.
 *
 * Never throws. It runs from the evening digest beside the rent sweep, and a reporting
 * correction must not be able to stop an email that reports money.
 */
export async function reconcileProcessingFees(
  { limit = MAX_ROWS }: { limit?: number } = {},
): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, corrected: 0, driftCents: 0, pending: 0 }

  if (!stripeWritesEnabled()) return out

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)

  const rows = await db
    .select({
      id: ledgerEntries.id,
      intentId: ledgerEntries.stripePaymentIntentId,
      storedFee: ledgerEntries.stripeFeeCents,
    })
    .from(ledgerEntries)
    .where(
      and(
        // EVERY provider charge, not only the rental fee. Room rentals are grossed up the same
        // way and were being left on their estimate for ever — so the revenue page reported a
        // processing cost that was right for laser time and a guess for everything else.
        //
        // Keyed on who PAID rather than on a list of sources, so a fourth thing Melanite ever
        // charges a provider for is covered the day it is written rather than the day somebody
        // remembers this file exists.
        eq(ledgerEntries.payer, 'provider'),
        eq(ledgerEntries.entryType, 'purchase'),
        // Subscription invoices carry no payment intent, so they cannot be looked up this way.
        // Their estimate stands until there is a reason to chase the invoice object too.
        isNotNull(ledgerEntries.stripePaymentIntentId),
        gte(ledgerEntries.createdAt, since),
      ),
    )
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)

  for (const row of rows) {
    if (!row.intentId) continue
    out.checked++

    let reported: number | undefined
    try {
      const intent = await stripeGet<IntentWithFee>(
        `/payment_intents/${row.intentId}?expand[]=latest_charge.balance_transaction`,
      )
      reported = intent.latest_charge?.balance_transaction?.fee
    } catch (err) {
      // One bad row must not end the sweep. A deleted intent, a rate limit, a network blip —
      // the next run picks it up.
      console.warn('[processing] could not read the fee for', row.intentId, err)
      continue
    }

    if (typeof reported !== 'number' || reported < 0) {
      out.pending++
      continue
    }

    if (row.storedFee === reported) continue

    // Signed on purpose. Over-recovering and under-recovering are different problems and
    // averaging them into an absolute figure would hide both.
    out.driftCents += (row.storedFee ?? 0) - reported
    out.corrected++

    await db
      .update(ledgerEntries)
      .set({ stripeFeeCents: reported })
      .where(eq(ledgerEntries.id, row.id))
  }

  return out
}

/**
 * What the predicted rate has actually been costing, over a window.
 *
 * The number Keoni needs in order to set `stripe_fee_pct` from evidence: charged, what Stripe
 * really took, and what was left. Reads only rows that have been reconciled against Stripe —
 * an estimate compared against itself would always agree and prove nothing.
 */
export async function processingSummary(days = 30): Promise<{
  rows: number
  chargedCents: number
  feeCents: number
  netCents: number
  /** The effective rate actually paid, as a fraction, or null with nothing to measure. */
  effectivePct: number | null
}> {
  const since = new Date(Date.now() - days * 86_400_000)

  const [row] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      chargedCents: sql<number>`coalesce(round(sum(${ledgerEntries.grossAmount}) * 100), 0)::int`,
      feeCents: sql<number>`coalesce(sum(${ledgerEntries.stripeFeeCents}), 0)::int`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.payer, 'provider'),
        eq(ledgerEntries.entryType, 'purchase'),
        isNotNull(ledgerEntries.stripeFeeCents),
        gte(ledgerEntries.createdAt, since),
      ),
    )

  const chargedCents = row?.chargedCents ?? 0
  const feeCents = row?.feeCents ?? 0

  return {
    rows: row?.rows ?? 0,
    chargedCents,
    feeCents,
    netCents: chargedCents - feeCents,
    effectivePct: chargedCents > 0 ? feeCents / chargedCents : null,
  }
}
