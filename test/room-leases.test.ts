import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Email is mocked here, not merely redirected: the decline path mails Keoni and the tenant, and
// this file is about WHEN that happens, which a real send cannot be asserted on.
const sent: { to: string; subject: string }[] = []
vi.mock('@/lib/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/email')>()
  return {
    ...real,
    sendEmail: vi.fn(async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject })
      return { delivered: true }
    }),
  }
})

// `appOrigin()` reads request headers to build the email's link, and a test has no request. The
// webhook route always does, so this stands in for it rather than letting the email path throw
// and be swallowed — which would leave the assertions below about emails proving nothing.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'appdev.melanitesuite.com', 'x-forwarded-proto': 'https' }),
}))

import type { SessionUser } from '@/lib/auth/session'
import { dashboardHref, navFor } from '@/lib/nav'
import { clearedForRoom } from '@/lib/rooms/access'
import {
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionChanged,
} from '@/lib/stripe/handlers'
import type { StripeInvoiceObject, StripeSubscriptionObject } from '@/lib/stripe/types'

// Monthly room leases against a real database (migration 0049, Keoni 4 November 2026).
//
// The webhooks are what matter most. Rent is a subscription, and every subscription handler here
// was written when the only ones were medical direction and the marketing membership — with
// `planFromMetadata` calling anything unlabelled medical direction. A tenant's rent must never
// open, close or touch anybody's booking gate.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const ROOM = 'zz-test-suite'
let providerId = ''
let leaseId = ''

const invoice = (id: string, amount = 69990) =>
  ({
    id,
    amount_paid: amount,
    amount_due: amount,
    parent: {
      subscription_details: {
        metadata: { provider_id: providerId, plan: 'room_lease', lease_id: leaseId },
      },
    },
  }) as unknown as StripeInvoiceObject

async function lease() {
  const [row] = (await sql.query(
    `SELECT status, past_due_since FROM room_leases WHERE id = $1`,
    [leaseId],
  )) as { status: string; past_due_since: string | null }[]
  return row
}

beforeAll(async () => {
  await sql.query(
    `INSERT INTO rooms (id, name, kind, monthly_price_cents, sort)
     VALUES ($1, 'ZZ Test Suite', 'monthly', 65000, 999)`,
    [ROOM],
  )
  const [p] = (await sql.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled, practice_type,
                            medical_director_status)
     VALUES ($1, 'x', true, 'Zzlease', 'Tenant', 'provider', 'active', 6, false, 'room_only', 'none')
     RETURNING id`,
    [`zz.lease.${Date.now()}@example.com`],
  )) as { id: string }[]
  providerId = p.id
  const [l] = (await sql.query(
    `INSERT INTO room_leases (provider_id, room_id, status, starts_on, monthly_cents, deposit_cents,
                              deposit_status, stripe_subscription_id)
     VALUES ($1, $2, 'active', '2026-11-01', 65000, 65000, 'held_outside', $3)
     RETURNING id`,
    [providerId, ROOM, `sub_zzlease_${Date.now()}`],
  )) as { id: string }[]
  leaseId = l.id
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM room_leases WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
  await sql.query(`DELETE FROM rooms WHERE id = $1`, [ROOM])
})

beforeEach(() => {
  sent.length = 0
})

describe('rent invoices', () => {
  it('records rent as its own stream, against the lease', async () => {
    const result = await handleInvoicePaid(invoice('in_zzlease_1'))
    expect(result.handled).toBe(true)

    const rows = (await sql.query(
      `SELECT source, subject_type, subject_id, gross_amount FROM ledger_entries
        WHERE stripe_invoice_id = 'in_zzlease_1'`,
    )) as Record<string, string>[]
    expect(rows).toEqual([
      { source: 'room_lease', subject_type: 'room_lease', subject_id: leaseId, gross_amount: '699.90' },
    ])
  })

  it('never touches medical direction or creates a membership', async () => {
    // The trap: `planFromMetadata` says medical_director for anything it does not know.
    const [p] = (await sql.query(
      `SELECT medical_director_status FROM providers WHERE id = $1`,
      [providerId],
    )) as { medical_director_status: string }[]
    expect(p.medical_director_status).toBe('none')

    const memberships = (await sql.query(`SELECT 1 FROM memberships WHERE provider_id = $1`, [
      providerId,
    ])) as unknown[]
    expect(memberships).toHaveLength(0)
  })

  it('records a replayed invoice once', async () => {
    await handleInvoicePaid(invoice('in_zzlease_1'))
    const rows = (await sql.query(
      `SELECT 1 FROM ledger_entries WHERE stripe_invoice_id = 'in_zzlease_1'`,
    )) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('writes nothing for the $0 invoice of a lease that starts on a later 1st', async () => {
    await handleInvoicePaid(invoice('in_zzlease_trial', 0))
    const rows = (await sql.query(
      `SELECT 1 FROM ledger_entries WHERE stripe_invoice_id = 'in_zzlease_trial'`,
    )) as unknown[]
    expect(rows).toHaveLength(0)
  })
})

describe('a declined rent', () => {
  it('marks the lease past due and tells Keoni and the tenant', async () => {
    await handleInvoicePaymentFailed(invoice('in_zzlease_2'))
    expect((await lease()).status).toBe('past_due')
    expect((await lease()).past_due_since).not.toBeNull()
    expect(sent.map((m) => m.subject).join(' | ')).toMatch(/Rent declined: Zzlease Tenant/)
    expect(sent.some((m) => /your rent .* was declined/i.test(m.subject))).toBe(true)
  })

  it('does not email again on Stripe’s retries', async () => {
    // Stripe re-sends `invoice.payment_failed` on every dunning retry. One decline, one email.
    await handleInvoicePaymentFailed(invoice('in_zzlease_2'))
    expect(sent).toHaveLength(0)
  })

  it('returns to good standing when the rent is paid', async () => {
    await handleInvoicePaid(invoice('in_zzlease_2'))
    const row = await lease()
    expect(row.status).toBe('active')
    expect(row.past_due_since).toBeNull()
  })
})

describe('the end of a lease', () => {
  it('ends when Stripe ends the subscription', async () => {
    await handleSubscriptionChanged(
      {
        id: 'sub_zz',
        status: 'canceled',
        metadata: { provider_id: providerId, plan: 'room_lease', lease_id: leaseId },
      } as unknown as StripeSubscriptionObject,
      'customer.subscription.deleted',
    )
    expect((await lease()).status).toBe('ended')
  })

  it('frees the space: one live lease per room, any number of ended ones', async () => {
    const [second] = (await sql.query(
      `INSERT INTO room_leases (provider_id, room_id, status, starts_on, monthly_cents,
                                deposit_status)
       VALUES ($1, $2, 'active', '2027-06-01', 65000, 'held_outside') RETURNING id`,
      [providerId, ROOM],
    )) as { id: string }[]
    expect(second.id).toBeTruthy()

    await expect(
      sql.query(
        `INSERT INTO room_leases (provider_id, room_id, status, starts_on, monthly_cents,
                                  deposit_status)
         VALUES ($1, $2, 'active', '2027-07-01', 65000, 'held_outside')`,
        [providerId, ROOM],
      ),
    ).rejects.toThrow(/room_leases_one_live_per_room/)
  })
})

describe('what a room tenant sees', () => {
  const tenant = {
    id: 't',
    email: 't@example.com',
    firstName: 'T',
    lastName: 'T',
    role: 'provider',
    status: 'active',
    bookingEnabled: false,
    roomRentalEnabled: true,
    medicalDirectorStatus: 'none',
    hasMedicalDirectorOnFile: false,
    licenseExpiry: null,
    requiresPasswordReset: false,
    revenueModel: 'rental',
    rentBasis: 'tier',
    practiceType: 'room_only',
  } as SessionUser

  it('has no laser in the menu, and lands on their room', () => {
    const labels = navFor(tenant).map((i) => i.label)
    expect(labels).toContain('Room Rental')
    for (const laser of ['Book Laser Time', 'Dashboard', 'Appointments', 'Membership']) {
      expect(labels).not.toContain(laser)
    }
    expect(dashboardHref(tenant)).toBe('/app/room-rental')
  })

  it('can rent the daily room without the laser booking switch', () => {
    // `bookingEnabled` is the LASER gate. A tenant who needed it on would be handed the laser.
    expect(clearedForRoom(tenant)).toBe(true)
    expect(clearedForRoom({ ...tenant, status: 'pending' })).toBe(false)
    // A laser provider still needs Keoni's switch, as before.
    expect(clearedForRoom({ ...tenant, practiceType: 'laser' })).toBe(false)
  })
})
