import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CLOSEOUT_GRACE_HOURS, closeoutWindowOpen } from '@/lib/end-of-use'
import { settleDueRent, unsettledRent } from '@/lib/rental/settle'

// Taking the rent after the session instead of at the booking.
//
// Keoni's change of 9 October: providers are frequently not paid by their own client until the
// work is done, so charging them to hold a slot is the wrong way round for the industry. The
// cost is that Melanite now extends credit on every session and has to collect.
//
// WHAT IS WORTH TESTING HERE is not that a charge works — that needs a card and a real Stripe
// call, and belongs in a manual pass. It is the ELIGIBILITY PREDICATE, because every way this
// can go wrong is a wrong answer to "is this session due yet":
//
//   too early  — a provider is charged for a session they are still allowed to tell us did not
//                happen, which is the generosity the twelve-hour window exists to give them
//   too late   — the fee is never taken and nobody notices until the month's takings are short
//   wrong rows — a cancelled or missed session is billed, answering Keoni's question for her
//
// The fixture provider has no card on purpose, so a selected booking fails at Stripe rather than
// taking test-mode money. That is enough: what is asserted is which rows the sweep PICKS.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const TAG = `ZZ SETTLE ${Date.now()}`
let providerId = ''
let providerServiceId = ''
const made: string[] = []

/** A past rental booking, `hoursAgo` before now, in whatever state. */
async function session(opts: {
  hoursAgo: number
  status?: 'upcoming' | 'completed' | 'cancelled' | 'no_show'
  waived?: boolean
  attempts?: number
  failedHoursAgo?: number
}): Promise<string> {
  const status = opts.status ?? 'completed'

  for (let slide = 0; slide < 400; slide += 2) {
    const h = opts.hoursAgo + slide
    try {
      const rows = (await sql.query(
        `INSERT INTO bookings
           (provider_id, provider_service_id, original_price, price, payment_source,
            duration_mins, start_time, end_time, status, notes,
            rent_waived_at, rent_charge_attempts, rent_charge_failed_at)
         VALUES ($1, $2, '0.00', '0.00', 'rental', 60,
                 now() - ($3::int || ' hours')::interval,
                 now() - (($3::int - 1) || ' hours')::interval,
                 $4, $5,
                 case when $6::bool then now() else null end,
                 $7::int,
                 case when $8::int is null then null
                      else now() - ($8::int || ' hours')::interval end)
         RETURNING id`,
        [
          providerId,
          providerServiceId,
          String(h),
          status,
          TAG,
          opts.waived ?? false,
          opts.attempts ?? 0,
          opts.failedHoursAgo ?? null,
        ],
      )) as { id: string }[]
      made.push(rows[0].id)
      return rows[0].id
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string }
      if ((e.code ?? e.cause?.code) !== '23P01') throw err
    }
  }
  throw new Error('could not place a fixture booking')
}

/** Which of our fixtures the sweep would pick, without charging anything.
 *
 *  Mirrors the predicate in `settleDueRent` rather than calling it, because calling it would
 *  attempt a real Stripe charge per row. Kept beside the real one in review: if they drift, the
 *  "picks exactly the due one" test below stops meaning anything. */
async function wouldPick(): Promise<string[]> {
  const rows = (await sql.query(
    `SELECT b.id
       FROM bookings b
       JOIN providers p ON p.id = b.provider_id
      WHERE b.notes = $1
        AND b.payment_source = 'rental'
        AND p.revenue_model = 'rental'
        AND b.status IN ('upcoming', 'completed')
        AND b.end_time < now() - ($2::int || ' hours')::interval
        AND b.rent_waived_at IS NULL
        AND b.rent_charge_attempts < 5
        AND (b.rent_charge_failed_at IS NULL
             OR b.rent_charge_failed_at < now() - interval '20 hours')
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le
           WHERE le.subject_type = 'booking' AND le.subject_id = b.id
             AND le.source = 'rental_fee' AND le.entry_type = 'purchase')
        AND NOT EXISTS (
          SELECT 1 FROM provider_pack_redemptions r
           WHERE r.booking_id = b.id AND r.voided_at IS NULL)`,
    [TAG, String(CLOSEOUT_GRACE_HOURS)],
  )) as { id: string }[]
  return rows.map((r) => r.id)
}

beforeAll(async () => {
  const [prov] = (await sql.query(
    `SELECT id FROM providers
      WHERE revenue_model = 'rental' AND billing_payment_method_id IS NULL LIMIT 1`,
  )) as { id: string }[]
  if (!prov) throw new Error('no card-less rental provider in dev — these tests need one')
  providerId = prov.id

  const [svc] = (await sql.query(
    `SELECT id FROM services WHERE name = 'Laser Hair Removal — Chin'`,
  )) as { id: string }[]

  const existing = (await sql.query(
    `SELECT id FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
    [providerId, svc.id],
  )) as { id: string }[]

  providerServiceId =
    existing[0]?.id ??
    (
      (await sql.query(
        `INSERT INTO provider_services (provider_id, service_id, price, duration_mins, is_active)
         VALUES ($1, $2, '0.00', 30, true) RETURNING id`,
        [providerId, svc.id],
      )) as { id: string }[]
    )[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`, [made])
  await sql.query(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [made])
})

describe('the grace period', () => {
  it('is the same twelve hours a provider has to close out', () => {
    // One number, three consequences — the close-out form, Keoni's missing-closeout list, and
    // billing. If they drifted, somebody would be charged for a session they were still allowed
    // to tell us had not happened.
    expect(CLOSEOUT_GRACE_HOURS).toBe(12)

    const endedJustInside = {
      startTime: new Date(Date.now() - (CLOSEOUT_GRACE_HOURS + 1) * 3_600_000),
      endTime: new Date(Date.now() - (CLOSEOUT_GRACE_HOURS - 0.5) * 3_600_000),
    }
    const endedJustOutside = {
      startTime: new Date(Date.now() - (CLOSEOUT_GRACE_HOURS + 2) * 3_600_000),
      endTime: new Date(Date.now() - (CLOSEOUT_GRACE_HOURS + 0.5) * 3_600_000),
    }
    expect(closeoutWindowOpen(endedJustInside), 'still theirs to close out').toBe(true)
    expect(closeoutWindowOpen(endedJustOutside), 'window shut, so billable').toBe(false)
  })
})

describe('which sessions are due', () => {
  it('does not touch one that ended an hour ago', async () => {
    // The provider may still be in the room on a long day, and has eleven hours left to tell us
    // it did not happen.
    const id = await session({ hoursAgo: 1 })
    expect(await wouldPick()).not.toContain(id)
  })

  it('takes one that ended outside the window', async () => {
    const id = await session({ hoursAgo: CLOSEOUT_GRACE_HOURS + 3 })
    expect(await wouldPick()).toContain(id)
  })

  it('takes one nobody ever marked completed', async () => {
    // The whole reason this is keyed on time. `markCompleted` has no confirmation dialog and no
    // consumer, and the digest already prints "Still marked upcoming — nobody closed this out",
    // so billing cannot wait for a button nobody presses.
    const id = await session({ hoursAgo: 30, status: 'upcoming' })
    expect(await wouldPick()).toContain(id)
  })

  it('never takes a cancelled session', async () => {
    // It did not happen. Whether the provider owes anything is Keoni's call and it waits in her
    // queue — a sweep that billed it would be answering her question for her, always the same
    // way, which is the behaviour she removed on 7 October.
    const id = await session({ hoursAgo: 40, status: 'cancelled' })
    expect(await wouldPick()).not.toContain(id)
  })

  it('never takes a no-show', async () => {
    const id = await session({ hoursAgo: 40, status: 'no_show' })
    expect(await wouldPick()).not.toContain(id)
  })

  it('never takes one Keoni has waived', async () => {
    const id = await session({ hoursAgo: 40, waived: true })
    expect(await wouldPick()).not.toContain(id)
  })

  it('stops retrying a card that has failed five times', async () => {
    // Otherwise a dead card produces a Stripe decline on every run forever, and — with receipts
    // on — an email each time.
    const id = await session({ hoursAgo: 40, attempts: 5, failedHoursAgo: 40 })
    expect(await wouldPick()).not.toContain(id)
  })

  it('waits before retrying a recent failure', async () => {
    // Long enough for the provider to read the email and update the card before the attempt
    // budget is spent on them.
    const soon = await session({ hoursAgo: 40, attempts: 1, failedHoursAgo: 2 })
    const stale = await session({ hoursAgo: 40, attempts: 1, failedHoursAgo: 30 })

    const due = await wouldPick()
    expect(due, 'failed two hours ago — leave it alone').not.toContain(soon)
    expect(due, 'failed thirty hours ago — try again').toContain(stale)
  })

  it('never takes one that is already billed', async () => {
    const id = await session({ hoursAgo: 40 })

    await sql.query(
      `INSERT INTO ledger_entries
         (source, payer, entry_type, subject_type, subject_id, provider_id,
          gross_amount, tip_amount, provider_payout, melanite_cut, payment_method,
          stripe_payment_intent_id, payout_status)
       VALUES ('rental_fee', 'provider', 'purchase', 'booking', $1, $2,
               '35.00', '0.00', '0.00', '35.00', 'stripe', $3, 'paid')`,
      [id, providerId, `pi_zzsettle_${id.slice(0, 8)}`],
    )

    expect(await wouldPick()).not.toContain(id)
  })
})

describe('running the sweep', () => {
  it('reports what it did without throwing on a card it cannot charge', async () => {
    // The fixture provider has no card, so every eligible row fails at the refusal inside
    // `chargeRentalFee` rather than at Stripe. What matters is that one unbillable session does
    // not stop the batch — the sweep drains a queue, it does not process an event.
    await session({ hoursAgo: 50 })

    const out = await settleDueRent({ limit: 5 })

    expect(out.charged).toBe(0)
    expect(out.failed + out.skipped).toBeGreaterThan(0)
    expect(out).toHaveProperty('chargedCents', 0)
  })

  it('is safe to run twice in a row', async () => {
    // Idempotency is at the item, not the run — there is deliberately no once-per-day key. Two
    // runs back to back must not double anything.
    const before = await ledgerCount()
    await settleDueRent({ limit: 5 })
    await settleDueRent({ limit: 5 })
    expect(await ledgerCount()).toBe(before)
  })
})

describe('what a provider owes', () => {
  it('counts only charges that were tried and refused', async () => {
    // The booking gate is built on this. Counting merely-unswept sessions would shut the
    // calendar every morning the sweep ran late, turning a latency problem into a correctness
    // one and throwing away the property the design rests on.
    const owed = await unsettledRent(providerId)
    expect(owed.failedCount).toBe(
      (
        (await sql.query(
          `SELECT count(*)::int AS n FROM bookings
            WHERE provider_id = $1 AND payment_source = 'rental'
              AND rent_charge_failed_at IS NOT NULL AND rent_waived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM ledger_entries le
                 WHERE le.subject_type = 'booking' AND le.subject_id = bookings.id
                   AND le.source = 'rental_fee' AND le.entry_type = 'purchase')`,
          [providerId],
        )) as { n: number }[]
      )[0].n,
    )
  })

  it('reports nothing owed for a provider with no failures', async () => {
    const [clean] = (await sql.query(
      `SELECT id FROM providers WHERE revenue_model = 'house' LIMIT 1`,
    )) as { id: string }[]
    const owed = await unsettledRent(clean.id)
    expect(owed).toEqual({ failedCount: 0, failedCents: 0, oldestDays: 0 })
  })
})

async function ledgerCount(): Promise<number> {
  const [row] = (await sql.query(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE subject_id = ANY($1::uuid[])`,
    [made],
  )) as { n: number }[]
  return row.n
}
