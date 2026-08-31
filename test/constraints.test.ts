import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/lib/db'

// Does the database actually REFUSE bad writes?
//
// The invariant tests prove today's rows are clean. That is a different claim: data can be clean
// because nothing has tried to corrupt it yet. These tests attempt the corruption and require
// Postgres to say no — which is the only way to know a constraint is still there after a
// migration, a schema edit, or a `drizzle-kit push` that quietly dropped one.
//
// Every row written here is tagged and removed in `afterAll`, including on failure.

const TAG = 'ZZ_CONSTRAINT_TEST'

let providerId: string
let serviceId: string
let providerServiceId: string

/** Asserts the statement is rejected, and by the constraint we expect rather than by luck.
 *
 *  Reads the constraint NAME off `error.cause`, not a substring of the message. The neon-http
 *  driver wraps failures in its own Error whose message is only "Failed query: …" — the Postgres
 *  detail, including `constraint` and the SQLSTATE `code`, lives on the cause. Matching on a
 *  message would have quietly passed for any error at all, which is precisely the trap: a test
 *  that expects a rejection and gets a syntax error looks green.
 */
async function rejects(query: ReturnType<typeof sql>, expectedConstraint: string) {
  let constraint: string | undefined
  let code: string | undefined
  let detail = ''

  try {
    await db.execute(query)
  } catch (err) {
    const cause = (err as { cause?: Record<string, unknown> }).cause
    constraint = cause?.constraint as string | undefined
    code = cause?.code as string | undefined
    detail = (cause?.message as string | undefined) ?? String(err)
  }

  expect(detail, 'the database accepted a write it should have refused').not.toBe('')
  expect(constraint, `rejected, but by ${constraint ?? code}: ${detail}`).toBe(expectedConstraint)
}

beforeAll(async () => {
  const [provider] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO providers (email, first_name, last_name, role, status)
      VALUES (${`${TAG}@example.com`}, 'ZZ', 'Constraint', 'provider', 'inactive')
      RETURNING id
    `)
  ).rows

  providerId = provider.id

  const [service] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO services (name, suggested_duration_mins, min_duration_mins, max_duration_mins, active)
      VALUES (${TAG}, 30, 15, 60, false)
      RETURNING id
    `)
  ).rows

  serviceId = service.id

  const [ps] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
      VALUES (${providerId}::uuid, ${serviceId}::uuid, '100.00', 30, false)
      RETURNING id
    `)
  ).rows

  providerServiceId = ps.id
})

afterAll(async () => {
  // Order matters — children first. Runs even if a test threw.
  await db.execute(sql`DELETE FROM equipment_checks WHERE note = ${TAG}`)
  await db.execute(sql`DELETE FROM ledger_entries WHERE note = ${TAG}`)
  await db.execute(sql`DELETE FROM room_bookings WHERE provider_id = ${providerId}::uuid`)
  await db.execute(sql`DELETE FROM checkout_links WHERE token LIKE ${`${TAG}%`}`)
  await db.execute(sql`DELETE FROM bookings WHERE client_name = ${TAG}`)
  await db.execute(sql`DELETE FROM client_package_items WHERE client_package_id IN (
    SELECT id FROM client_packages WHERE provider_id = ${providerId}::uuid
  )`)
  await db.execute(sql`DELETE FROM client_packages WHERE provider_id = ${providerId}::uuid`)
  await db.execute(sql`DELETE FROM provider_services WHERE provider_id = ${providerId}::uuid`)
  await db.execute(sql`DELETE FROM services WHERE name = ${TAG}`)
  await db.execute(sql`DELETE FROM clients WHERE name = ${TAG}`)
  await db.execute(sql`DELETE FROM providers WHERE id = ${providerId}::uuid`)
})

describe('room_bookings_no_overlap', () => {
  it('refuses a full day when a morning is already held', async () => {
    // The bug the exclusion constraint replaced a unique index to fix: (date, slot_type) is
    // unique for two `am` rows but says nothing about `full` overlapping `am`.
    await db.execute(sql`
      INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
      VALUES (${providerId}::uuid, '2099-01-05', 'am', '60.00', 'confirmed',
              '2099-01-05 15:00:00+00', '2099-01-05 20:00:00+00')
    `)

    await rejects(
      sql`
        INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
        VALUES (${providerId}::uuid, '2099-01-05', 'full', '100.00', 'confirmed',
                '2099-01-05 15:00:00+00', '2099-01-06 01:00:00+00')
      `,
      'room_bookings_no_overlap',
    )
  })

  it('allows the afternoon of a day whose morning is held', async () => {
    await db.execute(sql`
      INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
      VALUES (${providerId}::uuid, '2099-01-05', 'pm', '60.00', 'confirmed',
              '2099-01-05 20:00:00+00', '2099-01-06 01:00:00+00')
    `)

    const [{ n }] = (
      await db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM room_bookings WHERE rental_date = '2099-01-05'
      `)
    ).rows

    expect(Number(n)).toBe(2)
  })

  it('lets a cancelled hold free the slot', async () => {
    // Only pending and confirmed occupy the room. A cancellation must genuinely release it.
    await db.execute(sql`
      INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
      VALUES (${providerId}::uuid, '2099-02-10', 'full', '100.00', 'cancelled',
              '2099-02-10 15:00:00+00', '2099-02-11 01:00:00+00')
    `)

    // Same range, this time as a real booking. Must be accepted.
    await db.execute(sql`
      INSERT INTO room_bookings (provider_id, rental_date, slot_type, price, status, start_at, end_at)
      VALUES (${providerId}::uuid, '2099-02-10', 'full', '100.00', 'confirmed',
              '2099-02-10 15:00:00+00', '2099-02-11 01:00:00+00')
    `)

    const [{ n }] = (
      await db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM room_bookings
         WHERE rental_date = '2099-02-10' AND status = 'confirmed'
      `)
    ).rows

    expect(Number(n)).toBe(1)
  })
})

describe('ledger check constraints', () => {
  it('refuses a provider-paid entry that was split', async () => {
    // Room rental and membership are paid BY the provider, so there is nothing to share. A
    // split one would silently pay someone for money they handed over.
    await rejects(
      sql`
        INSERT INTO ledger_entries
          (source, payer, entry_type, subject_type, subject_id, provider_id,
           gross_amount, tip_amount, provider_payout, melanite_cut, payment_method, note)
        VALUES ('room_rental', 'provider', 'purchase', 'room_booking', gen_random_uuid(),
                ${providerId}::uuid, '60.00', '0.00', '30.00', '30.00', 'cash', ${TAG})
      `,
      'ledger_entries_provider_paid_is_unsplit',
    )
  })

  it('ACCEPTS a house booking, where Melanite keeps everything', async () => {
    // The mirror image of the provider-sold Groupon voucher the schema comment describes:
    // `provider_payout = 0, melanite_cut = gross + tip` for an appointment Melanite performed
    // itself. Worth asserting rather than assuming, because the shape is unusual enough to look
    // like a bug — and because `ledger_entries_provider_paid_is_unsplit` only exempts it by a
    // short-circuit: the payer is 'client', not 'provider', so the constraint never fires.
    await db.execute(sql`
      INSERT INTO ledger_entries
        (source, payer, entry_type, subject_type, subject_id, provider_id,
         gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
         stripe_payment_intent_id, payout_status, note)
      VALUES ('booking', 'client', 'purchase', 'booking', gen_random_uuid(),
              ${providerId}::uuid, '180.00', '25.00', '0.00', '205.00', 'stripe',
              ${`pi_${TAG}_house`}, 'paid', ${TAG})
    `)

    const [row] = (
      await db.execute<{ provider_payout: string; melanite_cut: string; payout_status: string }>(
        sql`SELECT provider_payout, melanite_cut, payout_status FROM ledger_entries
            WHERE stripe_payment_intent_id = ${`pi_${TAG}_house`}`,
      )
    ).rows

    expect(row.provider_payout).toBe('0.00')
    expect(row.melanite_cut).toBe('205.00')
    // Nothing is owed to anybody, so it is settled on arrival. Left 'pending' it would sit in
    // the payout queue for ever describing a payment nobody is going to make.
    expect(row.payout_status).toBe('paid')
  })

  it('refuses a Stripe entry with no Stripe reference', async () => {
    // Without one it cannot be reconciled, and is indistinguishable from a mislabelled manual
    // entry.
    await rejects(
      sql`
        INSERT INTO ledger_entries
          (source, payer, entry_type, subject_type, subject_id, provider_id,
           gross_amount, tip_amount, provider_payout, melanite_cut, payment_method, note)
        VALUES ('booking', 'client', 'purchase', 'booking', gen_random_uuid(),
                ${providerId}::uuid, '100.00', '0.00', '50.00', '50.00', 'stripe', ${TAG})
      `,
      'ledger_entries_stripe_needs_reference',
    )
  })

  it('accepts a membership entry referenced by invoice rather than intent', async () => {
    // Subscriptions bill through invoices, which have no payment intent — the constraint has to
    // accept either.
    await db.execute(sql`
      INSERT INTO ledger_entries
        (source, payer, entry_type, subject_type, subject_id, provider_id,
         gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
         stripe_invoice_id, note)
      VALUES ('membership', 'provider', 'purchase', 'membership', gen_random_uuid(),
              ${providerId}::uuid, '150.00', '0.00', '0.00', '150.00', 'stripe',
              ${`in_${TAG}`}, ${TAG})
    `)

    const [{ n }] = (
      await db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM ledger_entries WHERE stripe_invoice_id = ${`in_${TAG}`}
      `)
    ).rows

    expect(Number(n)).toBe(1)
  })

  it('refuses a second non-refund entry for one payment intent', async () => {
    // The guard against a webhook retry writing the same payment twice.
    const intent = `pi_${TAG}`

    await db.execute(sql`
      INSERT INTO ledger_entries
        (source, payer, entry_type, subject_type, subject_id, provider_id,
         gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
         stripe_payment_intent_id, note)
      VALUES ('booking', 'client', 'purchase', 'booking', gen_random_uuid(),
              ${providerId}::uuid, '100.00', '0.00', '50.00', '50.00', 'stripe', ${intent}, ${TAG})
    `)

    await rejects(
      sql`
        INSERT INTO ledger_entries
          (source, payer, entry_type, subject_type, subject_id, provider_id,
           gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
           stripe_payment_intent_id, note)
        VALUES ('booking', 'client', 'purchase', 'booking', gen_random_uuid(),
                ${providerId}::uuid, '100.00', '0.00', '50.00', '50.00', 'stripe', ${intent}, ${TAG})
      `,
      'ledger_entries_stripe_payment_intent_id_index',
    )
  })

  it('allows SEVERAL refunds against one payment intent', async () => {
    // Deliberately not covered by the unique index. Stripe reports amount_refunded
    // cumulatively, so two partial refunds legitimately produce two rows — an earlier version
    // keyed the index on (intent, entry_type) and made the second one fail.
    const intent = `pi_${TAG}`

    for (const amount of ['-10.00', '-15.00']) {
      await db.execute(sql`
        INSERT INTO ledger_entries
          (source, payer, entry_type, subject_type, subject_id, provider_id,
           gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
           stripe_payment_intent_id, note)
        VALUES ('booking', 'client', 'refund', 'booking', gen_random_uuid(),
                ${providerId}::uuid, ${amount}, '0.00', '0.00', ${amount}, 'stripe',
                ${intent}, ${TAG})
      `)
    }

    const [{ n }] = (
      await db.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM ledger_entries
         WHERE stripe_payment_intent_id = ${intent} AND entry_type = 'refund'
      `)
    ).rows

    expect(Number(n)).toBe(2)
  })
})

describe('equipment checks', () => {
  /** A booking to hang photographs off. Cancelled deliberately — nothing here should care, and a
   *  cancelled fixture cannot collide with a real appointment on the laser. */
  async function aBooking(): Promise<string> {
    const start = new Date(Date.UTC(2095, 0, 4, 17))
    const [row] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO bookings
          (provider_id, provider_service_id, client_name, original_price, price,
           payment_source, duration_mins, start_time, end_time, status)
        VALUES (${providerId}::uuid, ${providerServiceId}::uuid, ${TAG}, '100.00', '100.00',
                'comped', 60, ${start.toISOString()}::timestamptz,
                ${new Date(start.getTime() + 3_600_000).toISOString()}::timestamptz, 'cancelled')
        RETURNING id
      `)
    ).rows
    return row.id
  }

  it('accepts SEVERAL photos of the same end of the same session', async () => {
    // Two angles of one scratch is an ordinary thing to want, and "was this session bracketed?"
    // is an EXISTS rather than a count. A unique index on (booking, kind) would look tidy and
    // would quietly refuse the second photograph of a problem — which is the one that shows it.
    const bookingId = await aBooking()

    for (const key of ['equipment/zz-a.jpg', 'equipment/zz-b.jpg']) {
      await db.execute(sql`
        INSERT INTO equipment_checks (booking_id, provider_id, kind, storage_key, note)
        VALUES (${bookingId}::uuid, ${providerId}::uuid, 'before', ${key}, ${TAG})
      `)
    }

    const [row] = (
      await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM equipment_checks WHERE booking_id = ${bookingId}::uuid`,
      )
    ).rows

    expect(row.n).toBe(2)
  })

  it('refuses a photo against a booking that does not exist', async () => {
    // The record is an attribution. One pointing at no appointment attributes nothing, and the
    // FK is what stops a bad id becoming a row nobody can interpret.
    await rejects(
      sql`
        INSERT INTO equipment_checks (booking_id, provider_id, kind, storage_key, note)
        VALUES (gen_random_uuid(), ${providerId}::uuid, 'before', 'equipment/zz-orphan.jpg', ${TAG})
      `,
      'equipment_checks_booking_id_bookings_id_fk',
    )
  })

  it('will not let a provider or a booking be deleted out from under a photo', async () => {
    // Asserted against the catalog rather than by attempting a delete. A delete is refused by
    // `bookings`' own RESTRICT first, so trying it proves nothing about THIS constraint — the
    // rejection arrives under another name and the test would pass or fail for the wrong reason.
    //
    // What matters is that neither is 'c'. Cascade here would mean deleting a provider silently
    // erases the record of what state they left a shared machine in, which is the one thing this
    // table exists to remember.
    const rows = (
      await db.execute<{ conname: string; confdeltype: string }>(sql`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'equipment_checks'::regclass AND contype = 'f'
        ORDER BY conname
      `)
    ).rows

    expect(rows.map((r) => r.conname)).toEqual([
      'equipment_checks_booking_id_bookings_id_fk',
      'equipment_checks_provider_id_providers_id_fk',
    ])
    // 'r' is RESTRICT; 'c' would be CASCADE.
    expect(rows.every((r) => r.confdeltype === 'r')).toBe(true)
  })
})

describe('booking and package constraints', () => {
  it('refuses a booking that ends before it starts', async () => {
    await rejects(
      sql`
        INSERT INTO bookings
          (provider_id, provider_service_id, client_name, original_price, price,
           payment_source, duration_mins, start_time, end_time, status)
        VALUES (${providerId}::uuid, ${providerServiceId}::uuid, ${TAG}, '100.00', '100.00',
                'comped', 30, '2099-03-01 18:00:00+00', '2099-03-01 17:00:00+00', 'cancelled')
      `,
      'bookings_time_order',
    )
  })

  it('refuses using more package sessions than were bought', async () => {
    const [client] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO clients (name) VALUES (${TAG}) RETURNING id
      `)
    ).rows

    const [template] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO package_templates (provider_id, name, total_price, active)
        VALUES (${providerId}::uuid, ${TAG}, '500.00', false)
        RETURNING id
      `)
    ).rows

    const [pkg] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO client_packages (provider_id, client_id, package_template_id, status)
        VALUES (${providerId}::uuid, ${client.id}::uuid, ${template.id}::uuid, 'active')
        RETURNING id
      `)
    ).rows

    await rejects(
      sql`
        INSERT INTO client_package_items
          (client_package_id, service_id, per_session_value, qty_total, qty_used)
        VALUES (${pkg.id}::uuid, ${serviceId}::uuid, '100.00', 5, 6)
      `,
      'client_package_items_qty',
    )

    await db.execute(sql`DELETE FROM client_packages WHERE id = ${pkg.id}::uuid`)
    await db.execute(sql`DELETE FROM package_templates WHERE id = ${template.id}::uuid`)
  })

  it('keeps platform_settings a singleton', async () => {
    // Two settings rows would mean two different provider shares, and whichever query ran first
    // would decide what a provider earned.
    await rejects(
      sql`INSERT INTO platform_settings (id, stripe_platform_account_id) VALUES (2, 'acct_x')`,
      'platform_settings_singleton',
    )
  })
})
