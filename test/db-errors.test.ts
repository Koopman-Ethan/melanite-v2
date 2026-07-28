import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

import { db, ledgerEntries } from '@/lib/db'
import { isExclusionViolation, isUniqueViolation } from '@/lib/db/errors'

// Recognising a Postgres constraint violation through Drizzle.
//
// This looks like a triviality and was not. Drizzle wraps the driver error in a plain `Error`
// whose message is the failed SQL, and hangs the NeonDbError off `.cause` — so `err.code` is
// undefined and the message contains the query rather than the code. The obvious check,
// `String(err.code ?? err).includes('23505')`, never matches.
//
// Three places in this codebase were written that way and none had ever caught anything:
// a duplicate subscription invoice threw instead of being treated as already-recorded, and two
// booking paths would have shown a crash rather than "someone just booked that slot". Nothing
// revealed it, because a test that asserts `rejects.toThrow()` passes whether the error was
// recognised or not.
//
// So these assert against REAL violations, raised the way the app raises them.

const INVOICE = `in_zzerrtest_${Date.now()}`

const row = {
  source: 'membership' as const,
  payer: 'provider' as const,
  entryType: 'purchase' as const,
  subjectType: 'membership' as const,
  subjectId: '00000000-0000-0000-0000-000000000001',
  grossAmount: '1.00',
  tipAmount: '0.00',
  providerPayout: '0.00',
  melaniteCut: '1.00',
  paymentMethod: 'stripe' as const,
  stripeInvoiceId: INVOICE,
  payoutStatus: 'paid' as const,
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM ledger_entries WHERE stripe_invoice_id = ${INVOICE}`)
  await db.execute(sql`DELETE FROM room_bookings WHERE rental_date = '2096-03-03'::date`)
})

describe('isUniqueViolation', () => {
  it('recognises a real duplicate through the Drizzle wrapper', async () => {
    await db.insert(ledgerEntries).values(row)

    let caught: unknown
    try {
      await db.insert(ledgerEntries).values(row)
    } catch (err) {
      caught = err
    }

    expect(caught, 'the second insert should have been rejected').toBeDefined()
    expect(isUniqueViolation(caught)).toBe(true)

    // The check this replaced. Kept as an assertion so nobody reintroduces it believing it
    // works — the code is not on the error, it is on the error's cause.
    expect(String((caught as { code?: string })?.code ?? caught)).not.toContain('23505')
  })

  it('does not fire on unrelated errors', () => {
    expect(isUniqueViolation(new Error('something else'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation({ code: '23P01' })).toBe(false)
  })
})

describe('isExclusionViolation', () => {
  it('recognises an overlapping room booking through the wrapper', async () => {
    const [provider] = (await db.execute(
      sql`SELECT id FROM providers WHERE status = 'active' ORDER BY email LIMIT 1`,
    )).rows as { id: string }[]

    const insert = (slot: string, from: string, to: string) =>
      db.execute(sql`
        INSERT INTO room_bookings
          (provider_id, rental_date, slot_type, price, status, start_at, end_at)
        VALUES (${provider.id}::uuid, '2096-03-03'::date, ${slot}::room_slot_type, '60.00',
                'confirmed', ${`2096-03-03T${from}:00Z`}::timestamptz,
                ${`2096-03-03T${to}:00Z`}::timestamptz)
      `)

    await insert('am', '15:00', '20:00')

    let caught: unknown
    try {
      // A full day over a morning that is taken — different slot name, overlapping hours.
      // (Both ranges must be well-formed: an end before its start is rejected as a bad range,
      // not as an overlap, which is what the first version of this test actually triggered.)
      await insert('full', '15:00', '23:00')
    } catch (err) {
      caught = err
    }

    expect(caught, 'the overlap should have been rejected').toBeDefined()
    expect(isExclusionViolation(caught)).toBe(true)
    expect(isUniqueViolation(caught)).toBe(false)
  })
})
