import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Stripe is mocked: what matters is which calls a new card causes, not Stripe's answer to them.
const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
vi.mock('@/lib/stripe/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/stripe/client')>()
  return {
    ...real,
    stripePost: vi.fn(async (path: string, body: Record<string, unknown>) => {
      calls.push({ method: 'POST', path, body })
      return {}
    }),
    stripeGet: vi.fn(async (path: string) => {
      calls.push({ method: 'GET', path })
      return { data: [{ id: 'in_zzcard_open' }] }
    }),
  }
})

import { hasLiveLease, moveLeasesToCard } from '@/lib/rooms/lease'

// A replaced card must reach the rent (Ethan, 7 November 2026). A lease's subscription names the
// card it started with, and that outranks the customer's default, so saving a new card used to
// leave every rent retry on the old one — while the page told the tenant a new card would fix it.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const ROOM = 'zz-test-card-suite'
let providerId = ''
let leaseId = ''
const SUB = `sub_zzcard_${Date.now()}`

beforeAll(async () => {
  await sql.query(
    `INSERT INTO rooms (id, name, kind, monthly_price_cents, sort)
     VALUES ($1, 'ZZ Card Suite', 'monthly', 65000, 998)`,
    [ROOM],
  )
  const [p] = (await sql.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled, practice_type,
                            medical_director_status)
     VALUES ($1, 'x', true, 'Zzcard', 'Tenant', 'provider', 'active', 6, false, 'room_only', 'none')
     RETURNING id`,
    [`zz.card.${Date.now()}@example.com`],
  )) as { id: string }[]
  providerId = p.id
  const [l] = (await sql.query(
    `INSERT INTO room_leases (provider_id, room_id, status, starts_on, monthly_cents,
                              deposit_status, stripe_subscription_id)
     VALUES ($1, $2, 'active', '2026-11-01', 65000, 'held_outside', $3) RETURNING id`,
    [providerId, ROOM, SUB],
  )) as { id: string }[]
  leaseId = l.id
})

afterAll(async () => {
  await sql.query(`DELETE FROM room_leases WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
  await sql.query(`DELETE FROM rooms WHERE id = $1`, [ROOM])
})

beforeEach(() => {
  calls.length = 0
})

describe('a tenant saves a new card', () => {
  it('moves the rent onto it, and leaves a lease in good standing alone otherwise', async () => {
    await moveLeasesToCard(providerId, 'pm_new')
    expect(calls).toEqual([
      { method: 'POST', path: `/subscriptions/${SUB}`, body: { default_payment_method: 'pm_new' } },
    ])
  })

  it('tries the declined rent on it at once when the lease is past due', async () => {
    await sql.query(`UPDATE room_leases SET status = 'past_due' WHERE id = $1`, [leaseId])
    await moveLeasesToCard(providerId, 'pm_new')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /subscriptions/${SUB}`,
      `GET /invoices?subscription=${SUB}&status=open`,
      'POST /invoices/in_zzcard_open/pay',
    ])
    expect(calls[2].body).toEqual({ payment_method: 'pm_new' })
  })

  it('does nothing for an ended lease', async () => {
    await sql.query(`UPDATE room_leases SET status = 'ended' WHERE id = $1`, [leaseId])
    await moveLeasesToCard(providerId, 'pm_new')
    expect(calls).toHaveLength(0)
    expect(await hasLiveLease(providerId)).toBe(false)
  })

  it('counts a running lease as needing the card', async () => {
    await sql.query(`UPDATE room_leases SET status = 'active' WHERE id = $1`, [leaseId])
    expect(await hasLiveLease(providerId)).toBe(true)
  })
})
