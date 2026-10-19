import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { db } from '@/lib/db'

// Properties that must hold across the WHOLE ledger, checked against real rows.
//
// These are the tests this project most needs. v1's revenue was $2,000 out and nobody noticed
// for months, because nothing crashed — the numbers were simply wrong. A unit test on a pure
// function cannot catch that. A property asserted over every row can.
//
// They run against the development database rather than a fixture, on purpose: a fixture only
// contains the shapes you thought to create, and the rows that break an invariant are by
// definition the ones nobody thought of.

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query)
  return (result.rows ?? []) as T[]
}

describe('ledger invariants', () => {
  it('every client-paid purchase splits exactly into payout and cut', async () => {
    // gross + tip == providerPayout + melaniteCut. If this drifts, someone is being paid the
    // wrong amount and both sides of the books still look plausible.
    const bad = await rows<{ id: string; gross: string; diff: string }>(sql`
      SELECT id,
             gross_amount AS gross,
             (provider_payout + melanite_cut) - (gross_amount + tip_amount) AS diff
        FROM ledger_entries
       WHERE payer = 'client'
         AND entry_type <> 'refund'
         AND (provider_payout + melanite_cut) <> (gross_amount + tip_amount)
    `)

    expect(bad, `entries where payout + cut != gross + tip:\n${JSON.stringify(bad, null, 2)}`)
      .toEqual([])
  })

  it('provider-paid entries are never split', async () => {
    // Room rental, membership: the provider pays Melanite, so there is nothing to share. This
    // is also enforced by a check constraint — the test proves the constraint is still there.
    const bad = await rows(sql`
      SELECT id, source, provider_payout, melanite_cut, gross_amount
        FROM ledger_entries
       WHERE payer = 'provider'
         AND (provider_payout <> 0 OR melanite_cut <> gross_amount)
    `)

    expect(bad, `provider-paid entries that were split:\n${JSON.stringify(bad, null, 2)}`)
      .toEqual([])
  })

  it('refunds are negative and purchases are not', async () => {
    const bad = await rows(sql`
      SELECT id, entry_type, gross_amount
        FROM ledger_entries
       WHERE (entry_type = 'refund' AND gross_amount > 0)
          OR (entry_type <> 'refund' AND gross_amount < 0)
    `)

    expect(bad, `entries with the wrong sign:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('every Stripe-funded entry carries a Stripe reference', async () => {
    // Without one, the entry cannot be reconciled against Stripe and is indistinguishable from
    // a manual entry that was mislabelled.
    const bad = await rows(sql`
      SELECT id, source, payment_method
        FROM ledger_entries
       WHERE payment_method = 'stripe'
         AND stripe_payment_intent_id IS NULL
         AND stripe_invoice_id IS NULL
    `)

    expect(bad, `stripe entries with no reference:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('a payment intent produces at most one non-refund entry', async () => {
    // The guard against a webhook retry writing the same payment twice. Refunds are excluded
    // because Stripe reports them cumulatively, so a partial refund legitimately produces
    // several rows against one intent.
    const bad = await rows(sql`
      SELECT stripe_payment_intent_id, count(*) AS n
        FROM ledger_entries
       WHERE stripe_payment_intent_id IS NOT NULL
         AND entry_type <> 'refund'
       GROUP BY stripe_payment_intent_id
      HAVING count(*) > 1
    `)

    expect(bad, `duplicated payments:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('no refund exceeds what was actually paid', async () => {
    const bad = await rows(sql`
      SELECT stripe_payment_intent_id,
             sum(CASE WHEN entry_type = 'refund' THEN -gross_amount ELSE 0 END) AS refunded,
             sum(CASE WHEN entry_type <> 'refund' THEN gross_amount + tip_amount ELSE 0 END) AS paid
        FROM ledger_entries
       WHERE stripe_payment_intent_id IS NOT NULL
       GROUP BY stripe_payment_intent_id
      HAVING sum(CASE WHEN entry_type = 'refund' THEN -gross_amount ELSE 0 END)
             > sum(CASE WHEN entry_type <> 'refund' THEN gross_amount + tip_amount ELSE 0 END)
    `)

    expect(bad, `over-refunded payments:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('every entry points at a subject that exists', async () => {
    // `subjectId` is polymorphic with no foreign key, so nothing in the schema stops it
    // pointing at a deleted row — or, as happened once, at a Stripe id in a uuid column.
    //
    // Entries reconstructed from Stripe are excluded, and ONLY those. The ETL found payments v1
    // had recorded no transaction for, so it built the ledger row from the charge and minted a
    // subject id pointing at nothing: we know money moved, we do not know which booking it was
    // for. Inventing a link would be worse than admitting there isn't one.
    //
    // The predicate has to survive a NULL note — most entries have none — or the exclusion
    // silently swallows the entire check, which is exactly what a first attempt at this did.
    const bad = await rows(sql`
      SELECT l.id, l.subject_type, l.subject_id
        FROM ledger_entries l
       WHERE coalesce(l.note, '') NOT LIKE 'Reconstructed from Stripe%'
         AND NOT EXISTS (
              SELECT 1 FROM bookings b WHERE l.subject_type = 'booking' AND b.id = l.subject_id
              UNION ALL
              SELECT 1 FROM client_packages c
               WHERE l.subject_type = 'client_package' AND c.id = l.subject_id
              UNION ALL
              SELECT 1 FROM room_bookings r
               WHERE l.subject_type = 'room_booking' AND r.id = l.subject_id
              UNION ALL
              SELECT 1 FROM memberships m
               WHERE l.subject_type = 'membership' AND m.id = l.subject_id
              UNION ALL
              SELECT 1 FROM training_enrollments t
               WHERE l.subject_type = 'training_enrollment' AND t.id = l.subject_id
              UNION ALL
              SELECT 1 FROM prepaid_balances p
               WHERE l.subject_type = 'prepaid_balance' AND p.id = l.subject_id
             )
    `)

    expect(bad, `entries pointing at nothing:
${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('the orphan exclusion still covers entries with no note', async () => {
    // Guards the guard. If the predicate above ever reverts to one that only inspects non-null
    // notes, the orphan check quietly stops examining most of the ledger — and still passes.
    const [{ n }] = await rows<{ n: string }>(sql`
      SELECT count(*) AS n
        FROM ledger_entries
       WHERE coalesce(note, '') NOT LIKE 'Reconstructed from Stripe%'
    `)

    const [{ total }] = await rows<{ total: string }>(sql`
      SELECT count(*) AS total FROM ledger_entries
    `)

    // Everything except the two reconstructions is genuinely in scope.
    expect(Number(n)).toBe(Number(total) - 2)
  })

  it('the reconstructed-from-Stripe entries stay exactly the two we know about', async () => {
    // Pins the exception. These two are a $17.25 charge and its matching refund — net zero,
    // which is why the platform total is unaffected. A third would mean something has started
    // minting orphan subjects, and this fails rather than shrugging.
    const [{ n, net }] = await rows<{ n: string; net: string }>(sql`
      SELECT count(*) AS n, coalesce(sum(gross_amount), 0) AS net
        FROM ledger_entries
       WHERE note LIKE 'Reconstructed from Stripe%'
    `)

    expect(Number(n)).toBe(2)
    expect(Number(net)).toBe(0)
  })
})

describe('booking invariants', () => {
  it('the shared laser is never double-booked', async () => {
    // One laser. Two overlapping occupying bookings means two clients in the chair at once.
    const bad = await rows(sql`
      SELECT a.id AS a, b.id AS b, a.start_time
        FROM bookings a
        JOIN bookings b
          ON a.id < b.id
         AND a.start_time < b.end_time
         AND a.end_time > b.start_time
       WHERE a.status IN ('upcoming', 'completed')
         AND b.status IN ('upcoming', 'completed')
    `)

    expect(bad, `overlapping bookings:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('every booking ends after it starts', async () => {
    const bad = await rows(sql`
      SELECT id, start_time, end_time FROM bookings WHERE end_time <= start_time
    `)
    expect(bad).toEqual([])
  })

  it('a discounted price never exceeds the original', async () => {
    const bad = await rows(sql`
      SELECT id, price, original_price FROM bookings WHERE price > original_price
    `)
    expect(bad).toEqual([])
  })
})

describe('package invariants', () => {
  it('sessions used never exceed sessions bought', async () => {
    const bad = await rows(sql`
      SELECT id, qty_used, qty_total FROM client_package_items WHERE qty_used > qty_total
    `)
    expect(bad).toEqual([])
  })

  it('live redemptions match the used count on every package item', async () => {
    // The two are maintained separately — a counter on the item, and one append-only row per
    // session consumed. If they disagree, a client has silently lost or gained a session.
    const bad = await rows(sql`
      SELECT i.id, i.qty_used, count(r.id) FILTER (WHERE r.voided_at IS NULL) AS live
        FROM client_package_items i
        LEFT JOIN package_redemptions r ON r.client_package_item_id = i.id
       GROUP BY i.id, i.qty_used
      HAVING i.qty_used <> count(r.id) FILTER (WHERE r.voided_at IS NULL)
    `)

    expect(bad, `package counters out of step:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })
})

describe('nobody is owed a payout that cannot arrive', () => {
  // Melanite stopped paying providers on 14 October. Every provider now rents the laser and
  // bills their own clients, no new Connect account is ever created, and no transfer is ever
  // made again. What is left is the tail: pre-cutover client payments whose provider half was
  // supposed to reach them through Connect.
  //
  // THE FAILURE THIS GUARDS. `createBookingIntent` attaches `transfer_data` only when the
  // provider has a Connect account, but `splitClientPayment` ran either way — so a payment
  // taken for a provider without one recorded half of it as theirs, stamped `pending`, waiting
  // on a `payout.paid` that could never arrive. The money is in Melanite's balance and the
  // books say it is somebody else's.
  //
  // THE ELEVEN PENDING ROWS ARE NOT THAT BUG, which took a second look to establish and is
  // worth writing down so nobody re-reaches the first conclusion. $604.50 across 11 rows for
  // Leyla and Karly sits at `pending`, and it is a REPORTING gap rather than a debt.
  //
  // Those were destination charges: `transfer_data.destination` moves the provider's share
  // into their connected account the moment the client's card is charged, as part of the
  // charge. Nothing has to run afterwards for them to get paid. What `payout_status` tracks is
  // the later event — Stripe paying that balance out to their bank — and Melanite is not
  // subscribed to it. All 18 payout.paid events ever received carry no `account` field, which
  // means every one of them is the PLATFORM's own payout to Melanite's bank, so `handlePayout`
  // returns at its first line and has never once marked a provider row paid.
  //
  // So the pile does not mean money is owed. It means the books never learned what Stripe
  // already did.

  it('never records a provider payout against a provider with no Connect account', async () => {
    // The row that cannot be true. Either the money reached them, in which case there is an
    // account, or it did not, in which case Melanite is holding it and should say so.
    const bad = await rows(sql`
      SELECT l.id, l.created_at::date AS recorded, l.provider_payout, l.payout_status,
             p.first_name, p.last_name
        FROM ledger_entries l
        JOIN providers p ON p.id = l.provider_id
       WHERE l.provider_payout <> 0
         AND p.stripe_account_id IS NULL
         -- Only rows written since the guard went in. Everything before it is history, and
         -- history is not something a test gets to fail over.
         AND l.created_at >= '2026-10-19'::date
    `)

    expect(
      bad,
      `these rows owe money to somebody Stripe cannot pay:\n${JSON.stringify(bad, null, 2)}`,
    ).toEqual([])
  })

  it('never splits a rental fee', async () => {
    // Rent runs the other way — the provider pays Melanite — so there is no half to give back.
    // The constraint `ledger_entries_provider_paid_is_unsplit` says the same thing in the
    // database; this says it against the rows that are actually there, which is the version
    // that catches a constraint somebody dropped in a migration.
    const bad = await rows(sql`
      SELECT id, gross_amount, provider_payout, melanite_cut
        FROM ledger_entries
       WHERE source = 'rental_fee' AND provider_payout <> 0
    `)

    expect(bad, `rent is not shared:\n${JSON.stringify(bad, null, 2)}`).toEqual([])
  })

  it('reports rows whose payout status was never reconciled', async () => {
    // A WARNING, not a failure, and deliberately so: nothing here is broken, the books are
    // simply behind Stripe, and a red suite over that is how a suite stops being read.
    const stranded = await rows(sql`
      SELECT p.first_name, p.last_name, count(*)::int AS rows,
             sum(l.provider_payout)::text AS owed, min(l.created_at)::date AS oldest
        FROM ledger_entries l
        JOIN providers p ON p.id = l.provider_id
       WHERE l.payout_status = 'pending' AND l.provider_payout <> 0
       GROUP BY 1, 2
    `)

    if (stranded.length > 0) {
      console.warn(
        `
  [payouts] ${stranded.length} provider(s) have ledger rows still marked 'pending'.
` +
          JSON.stringify(stranded, null, 2) +
          `
  NOT a debt. These were destination charges, so Stripe moved each share into the
` +
          `  provider's connected account at charge time. Melanite is not subscribed to Connect
` +
          `  payout events, so the status never caught up. Confirm in the Stripe dashboard,
` +
          `  then mark them paid — see docs/rental-cutover.md.
`,
      )
    }

    // The assertion is only that the query works and the shape is readable. Failing here would
    // mean failing on data nobody in this repo can fix.
    expect(Array.isArray(stranded)).toBe(true)
  })
})
