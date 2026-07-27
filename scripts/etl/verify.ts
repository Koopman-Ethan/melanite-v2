// Reconciles the loaded ledger against Stripe, which is the source of truth for money.
//
// Run: npx tsx scripts/etl/verify.ts
//
// It deliberately does NOT reconcile against v1's numbers. v1's `transactions` table holds
// one row covering one of two booking payments and contains no refunds at all, so matching
// it would mean reproducing a known-wrong figure. Expected values come from Stripe; see
// ./README.md for their derivation.

import { eq, ne, sql } from 'drizzle-orm'

import { db } from '../db'
import { ledgerEntries } from '@/lib/db/schema'

/** Derived from the live Stripe account (10 payment intents, has_more: false).
 *  Update alongside any re-pull of staged data.
 *
 *  Both columns are NET of refunds, since that is what the query below computes. Gross
 *  collected before refunds was $2,227.25 across all sources; $77.25 was refunded. */
const EXPECTED: Record<string, { gross: string; cut: string }> = {
  // 2 purchases ($150.00 + $17.25) less a $17.25 refund.
  booking: { gross: '150.00', cut: '52.75' },
  membership: { gross: '600.00', cut: '600.00' },
  training: { gross: '1400.00', cut: '1400.00' },
  // $60.00 rental, fully refunded.
  room_rental: { gross: '0.00', cut: '0.00' },
  package: { gross: '0.00', cut: '0.00' },
}

const TOTAL_CUT = '2052.75'

const fmt = (n: unknown) => Number(n ?? 0).toFixed(2)

/** Only Stripe-funded entries can be reconciled against Stripe. Cherry, Groupon, cash and
 *  cheque payments are real revenue that never produced a Stripe object, so including them
 *  here would report a permanent, growing "failure" that is actually correct data. */
const STRIPE_ONLY = eq(ledgerEntries.paymentMethod, 'stripe')

async function main() {
  // gross here is purchases + refunds netted, matching how Stripe reports it.
  const bySource = await db
    .select({
      source: ledgerEntries.source,
      gross: sql<string>`sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount})`,
      cut: sql<string>`sum(${ledgerEntries.melaniteCut})`,
      payout: sql<string>`sum(${ledgerEntries.providerPayout})`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .where(STRIPE_ONLY)
    .groupBy(ledgerEntries.source)

  const seen = new Map(bySource.map((r) => [r.source as string, r]))
  let failures = 0

  console.log('source          entries      gross        cut     expected cut')
  console.log('─────────────────────────────────────────────────────────────')

  for (const [source, exp] of Object.entries(EXPECTED)) {
    const row = seen.get(source)
    const gross = fmt(row?.gross)
    const cut = fmt(row?.cut)
    const ok = gross === exp.gross && cut === exp.cut
    if (!ok) failures++

    console.log(
      `${source.padEnd(14)} ${String(row?.entries ?? 0).padStart(7)} ` +
        `${gross.padStart(10)} ${cut.padStart(10)}     ${exp.cut.padStart(9)}  ${ok ? 'ok' : 'MISMATCH'}`,
    )
  }

  const [totals] = await db
    .select({
      cut: sql<string>`sum(${ledgerEntries.melaniteCut})`,
      payout: sql<string>`sum(${ledgerEntries.providerPayout})`,
    })
    .from(ledgerEntries)
    .where(STRIPE_ONLY)

  console.log('─────────────────────────────────────────────────────────────')
  console.log(`stripe revenue    ${fmt(totals.cut).padStart(12)}   expected ${TOTAL_CUT}`)
  console.log(`provider payouts  ${fmt(totals.payout).padStart(12)}`)

  if (fmt(totals.cut) !== TOTAL_CUT) failures++

  // Non-Stripe money is reported, never asserted — there is nothing to reconcile it against.
  // Showing it here keeps it visible rather than letting it look like it does not exist.
  const offStripe = await db
    .select({
      method: ledgerEntries.paymentMethod,
      cut: sql<string>`sum(${ledgerEntries.melaniteCut})`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .where(ne(ledgerEntries.paymentMethod, 'stripe'))
    .groupBy(ledgerEntries.paymentMethod)

  if (offStripe.length) {
    console.log('\nrecorded outside Stripe (not reconcilable — reported only):')
    for (const r of offStripe) {
      console.log(`  ${r.method.padEnd(10)} ${fmt(r.cut).padStart(10)}  ${r.entries} entries`)
    }
  }

  // Purchase-side identity, deliberately across ALL payment methods — a hand-entered Cherry
  // or Groupon row still has to balance, even though it cannot be reconciled against Stripe.
  // Refunds are excluded because an unreversed refund puts the whole amount on melaniteCut
  // with providerPayout 0, which breaks the identity by design.
  const broken = await db
    .select({ id: ledgerEntries.id, source: ledgerEntries.source })
    .from(ledgerEntries)
    .where(
      sql`${ledgerEntries.entryType} = 'purchase'
          AND ${ledgerEntries.melaniteCut} + ${ledgerEntries.providerPayout}
            <> ${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}`,
    )

  if (broken.length) {
    failures++
    console.log(`\n${broken.length} purchase row(s) where cut + payout <> gross + tip:`)
    for (const r of broken) console.log(`  ${r.source} ${r.id}`)
  }

  console.log(failures === 0 ? '\nreconciled' : `\n${failures} check(s) failed`)
  // Set the code rather than calling process.exit — exiting while the neon-http agent still
  // holds handles trips a libuv assertion on Windows.
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
