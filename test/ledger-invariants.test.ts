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
