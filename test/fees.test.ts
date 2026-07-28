import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { chargeBookingFee, feeCents, type FeePolicy } from '@/lib/stripe/fees'
import { splitFee } from '@/lib/money'

// No-show and late-cancellation fees.
//
// This is the only code in the app that takes money from someone who is not present to object.
// v1 never charged either fee and could not have — it saved no card — so there is no prior
// behaviour to fall back on if this is wrong.
//
// Every refusal happens BEFORE the Stripe call, which is what makes them testable for real:
// a booking with no card on file never reaches the API. The tests below drive the actual
// function against actual rows and assert it declines, because a fee charged in one of these
// situations is money taken from a client who did not owe it.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const POLICY: FeePolicy = {
  noShowPct: 0.5,
  cancellationAmount: 50,
  lateHours: 24,
  providerSharePct: 0.5,
}

let providerId = ''
let providerServiceId = ''
const made: { bookings: string[]; clients: string[] } = { bookings: [], clients: [] }

async function makeClient(opts: { card?: boolean; consent?: boolean }) {
  const rows = (await sql.query(
    `INSERT INTO clients (name, email, stripe_customer_id, default_payment_method_id,
                          payment_method_type, card_brand, card_last4, card_on_file_consent_at)
     VALUES ('ZZ Fee Client', $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      `zz.fee.${Date.now()}.${made.clients.length}@example.com`,
      opts.card ? 'cus_zzfee' : null,
      opts.card ? 'pm_zzfee' : null,
      opts.card ? 'card' : null,
      opts.card ? 'visa' : null,
      opts.card ? '4242' : null,
      opts.consent ? new Date().toISOString() : null,
    ],
  )) as { id: string }[]
  made.clients.push(rows[0].id)
  return rows[0].id
}

async function makeBooking(opts: { clientId: string | null; price: string; hourOffset: number }) {
  const start = new Date(Date.UTC(2097, 3, 3, 14 + opts.hourOffset)).toISOString()
  const end = new Date(Date.UTC(2097, 3, 3, 15 + opts.hourOffset)).toISOString()
  const rows = (await sql.query(
    `INSERT INTO bookings
       (provider_id, provider_service_id, client_id, client_name, client_email, original_price,
        price, payment_source, duration_mins, start_time, end_time, status)
     VALUES ($1, $2, $3, 'ZZ Fee Client', NULL, $4, $4, 'checkout_link', 60,
             $5::timestamptz, $6::timestamptz, 'upcoming')
     RETURNING id`,
    [providerId, providerServiceId, opts.clientId, opts.price, start, end],
  )) as { id: string }[]
  made.bookings.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  const rows = (await sql.query(
    `SELECT id, provider_id FROM provider_services WHERE is_active LIMIT 1`,
  )) as { id: string; provider_id: string }[]
  providerServiceId = rows[0].id
  providerId = rows[0].provider_id
})

afterAll(async () => {
  for (const id of made.bookings) {
    await sql.query(`DELETE FROM ledger_entries WHERE subject_id = $1`, [id])
    await sql.query(`DELETE FROM bookings WHERE id = $1`, [id])
  }
  for (const id of made.clients) await sql.query(`DELETE FROM clients WHERE id = $1`, [id])
})

describe('what the fee comes to', () => {
  it('charges a proportion of the price for a no-show', () => {
    expect(feeCents('no_show_fee', '300.00', POLICY)).toBe(15000)
    expect(feeCents('no_show_fee', '175.00', POLICY)).toBe(8750)
  })

  it('charges a flat amount for a late cancellation, whatever was booked', () => {
    // The cost is the empty slot, which is the same whether a $150 or a $400 treatment was in
    // it. A proportion here would penalise the client for booking something expensive.
    expect(feeCents('late_cancellation_fee', '150.00', POLICY)).toBe(5000)
    expect(feeCents('late_cancellation_fee', '400.00', POLICY)).toBe(5000)
  })

  it('rounds a half-cent rather than truncating it', () => {
    // $175.01 at 50% is 8750.5 cents. Truncating would quietly favour the client every time.
    expect(feeCents('no_show_fee', '175.01', POLICY)).toBe(8751)
  })

  it('comes to nothing when the booking had no price', () => {
    // A comped appointment or a package redemption is priced at zero, and half of nothing is
    // nothing. The caller treats this as "skip", not "charge $0".
    expect(feeCents('no_show_fee', '0.00', POLICY)).toBe(0)
  })

  it('splits evenly, with the parts always summing to the whole', () => {
    for (const price of ['150.00', '175.01', '333.33', '0.01']) {
      const amount = feeCents('no_show_fee', price, POLICY)
      const split = splitFee({ amountCents: amount, providerSharePct: POLICY.providerSharePct })
      expect(split.providerPayoutCents + split.melaniteCutCents).toBe(amount)
    }
  })
})

describe('when a fee must NOT be charged', () => {
  it('refuses when the appointment does not exist', async () => {
    const result = await chargeBookingFee('00000000-0000-0000-0000-000000000000', 'no_show_fee')
    expect(result.charged).toBeUndefined()
    expect(result.error).toMatch(/does not exist/i)
  })

  it('skips a walk-in with no client record', async () => {
    // No client row means no customer and no card. Nothing to charge, and not an error worth
    // shouting about — a provider can take a booking without one.
    const bookingId = await makeBooking({ clientId: null, price: '200.00', hourOffset: 0 })
    const result = await chargeBookingFee(bookingId, 'no_show_fee')

    expect(result.charged).toBeUndefined()
    expect(result.skipped).toMatch(/no client record/i)
  })

  it('refuses when there is no card on file, and puts it in the queue', async () => {
    const clientId = await makeClient({ card: false, consent: false })
    const bookingId = await makeBooking({ clientId, price: '200.00', hourOffset: 1 })

    const result = await chargeBookingFee(bookingId, 'no_show_fee')
    expect(result.charged).toBeUndefined()
    expect(result.skipped).toMatch(/no card on file/i)

    // Stamped on the booking so it surfaces for an admin. A declined fee that is only a toast
    // is a fee nobody ever collects.
    const [row] = (await sql.query(
      `SELECT fee_charge_failed_at, fee_charge_error FROM bookings WHERE id = $1`,
      [bookingId],
    )) as Record<string, unknown>[]
    expect(row.fee_charge_failed_at).not.toBeNull()
    expect(String(row.fee_charge_error)).toMatch(/no card on file/i)
  })

  it('refuses a card that was saved without consent', async () => {
    // The most important one here. A card can end up attached by another route; Stripe would
    // accept the charge and the client never agreed to it.
    const clientId = await makeClient({ card: true, consent: false })
    const bookingId = await makeBooking({ clientId, price: '200.00', hourOffset: 2 })

    const result = await chargeBookingFee(bookingId, 'no_show_fee')
    expect(result.charged).toBeUndefined()
    expect(result.skipped).toMatch(/did not authorise/i)
  })

  it('refuses to charge the same appointment twice', async () => {
    // A provider marking no-show, undoing it, and marking it again must not bill the client
    // twice. The guard is a ledger lookup, so it survives a page reload and a second admin.
    const clientId = await makeClient({ card: true, consent: true })
    const bookingId = await makeBooking({ clientId, price: '200.00', hourOffset: 3 })

    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id, client_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('booking', 'client', 'no_show_fee', 'booking', $1, $2, $3,
               '100.00', '0.00', '50.00', '50.00', 'stripe', $4, 'paid')`,
      // `ledger_entries_stripe_needs_reference` requires a Stripe id on any stripe-method row,
      // which is the schema refusing to record money it cannot trace back.
      [bookingId, providerId, clientId, `pi_zzfee_${Date.now()}`],
    )

    const result = await chargeBookingFee(bookingId, 'no_show_fee')
    expect(result.charged).toBeUndefined()
    expect(result.skipped).toMatch(/already been charged/i)
  })

  it('skips a booking with nothing to base a fee on', async () => {
    // A package redemption is priced at zero. Charging half of nothing, or worse a flat amount
    // the client never agreed to, would be inventing a debt.
    const clientId = await makeClient({ card: true, consent: true })
    const bookingId = await makeBooking({ clientId, price: '0.00', hourOffset: 4 })

    const result = await chargeBookingFee(bookingId, 'no_show_fee')
    expect(result.charged).toBeUndefined()
    expect(result.skipped).toMatch(/no price/i)
  })

  it('writes no ledger entry on any refusal', async () => {
    // The invariant behind all of the above: nothing that declined may leave money recorded.
    const [row] = (await sql.query(
      `SELECT count(*)::int AS n FROM ledger_entries
        WHERE subject_id = ANY($1::uuid[]) AND entry_type = 'no_show_fee'`,
      [made.bookings],
    )) as { n: number }[]

    // Exactly one: the row this file inserted by hand to test the duplicate guard.
    expect(row.n).toBe(1)
  })
})
