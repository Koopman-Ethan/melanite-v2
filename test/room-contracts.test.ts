import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The file store is mocked: these tests are about who may put a contract on file and what a lease
// does with one, not about whether Vercel stores bytes. `landed` is what the store says is there.
let landed: { sizeBytes: number; contentType: string } | null = null
const deleted: string[] = []
vi.mock('@/lib/blob', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/blob')>()
  return {
    ...real,
    blobConfigured: () => true,
    headContract: vi.fn(async () => landed),
    deleteContract: vi.fn(async (key: string) => {
      deleted.push(key)
      return { ok: true }
    }),
  }
})

// Stripe is mocked too. Renewing a lease moves the day Stripe stops the rent, and that call is
// the thing to assert on.
const stripe: { path: string; body: Record<string, unknown> }[] = []
vi.mock('@/lib/stripe/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/stripe/client')>()
  return {
    ...real,
    stripePost: vi.fn(async (path: string, body: Record<string, unknown>) => {
      stripe.push({ path, body })
      // Enough of an answer for `startLease`, which stores the product and subscription ids.
      return { id: `zz_contract_mock_${stripe.length}_${Date.now()}`, status: 'active' }
    }),
  }
})

import { newContractKey, parseContractKey } from '@/lib/blob'
import {
  contractUploadPath,
  getContractState,
  mayHandleContractFor,
  recordContract,
} from '@/lib/rooms/contracts'
import { recordNotice, renewLease, startLease } from '@/lib/rooms/lease'

// Signed room contracts (migration 0050, 11 November 2026): the tenant or Keoni uploads one, a
// lease cannot start without it, and a lease ends when it does unless renewed on a new one.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

const ROOM = 'zz-test-contract-suite'
const SUB = `sub_zzcontract_${Date.now()}`
let tenantId = ''
let otherId = ''
let leaseId = ''

const admin = { id: '', role: 'platform_owner' as const }
const asTenant = () => ({ id: tenantId, role: 'provider' as const })
const asOther = () => ({ id: otherId, role: 'provider' as const })

async function newTenant(tag: string, role = 'provider') {
  const [p] = (await sql.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled, practice_type,
                            medical_director_status, stripe_billing_customer_id,
                            billing_payment_method_id)
     VALUES ($1, 'x', true, 'Zzcontract', $2, $3, 'active', 6, false, 'room_only', 'none',
             'cus_zzcontract', 'pm_zzcontract')
     RETURNING id`,
    [`zz.contract.${tag}.${Date.now()}@example.com`, tag, role],
  )) as { id: string }[]
  return p.id
}

/** Uploads a contract the way the button does: ask where, (the browser sends it), report back. */
async function upload(actor: { id: string; role: 'platform_owner' | 'provider' }, forProvider: string) {
  const place = await contractUploadPath(actor as never, forProvider, 'application/pdf')
  if ('error' in place) return place
  landed = { sizeBytes: 250_000, contentType: 'application/pdf' }
  const result = await recordContract(actor as never, place.pathname)
  return 'error' in result ? result : { pathname: place.pathname }
}

beforeAll(async () => {
  // Clears what an earlier run left if it died before `afterAll` — otherwise one crash makes
  // every later run fail on the room's primary key instead of on whatever is actually wrong.
  await sql.query(`DELETE FROM room_contracts WHERE provider_id IN
                     (SELECT id FROM providers WHERE email LIKE 'zz.contract.%@example.com')`)
  await sql.query(`DELETE FROM room_leases WHERE room_id = $1`, [ROOM])
  await sql.query(`DELETE FROM providers WHERE email LIKE 'zz.contract.%@example.com'`)
  await sql.query(
    `INSERT INTO rooms (id, name, kind, monthly_price_cents, sort)
     VALUES ($1, 'ZZ Contract Suite', 'monthly', 65000, 997)
     ON CONFLICT (id) DO NOTHING`,
    [ROOM],
  )
  tenantId = await newTenant('tenant')
  otherId = await newTenant('other')
  admin.id = await newTenant('keoni', 'platform_owner')
})

afterAll(async () => {
  const ids = [tenantId, otherId, admin.id].filter(Boolean)
  await sql.query(`DELETE FROM room_contracts WHERE provider_id = ANY($1)`, [ids])
  await sql.query(`DELETE FROM room_leases WHERE provider_id = ANY($1)`, [ids])
  await sql.query(`DELETE FROM providers WHERE id = ANY($1)`, [ids])
  await sql.query(`DELETE FROM rooms WHERE id = $1`, [ROOM])
})

beforeEach(() => {
  landed = null
  deleted.length = 0
  stripe.length = 0
})

describe('contract file names', () => {
  it('round-trips whose contract a key is', () => {
    const key = newContractKey(tenantId, '0b6f5e3a-1111-4c1d-9a6e-2f0d8c7b5a41', 'application/pdf')!
    expect(key).toMatch(/^contracts\/dev\//)
    expect(parseContractKey(key)).toEqual({
      providerId: tenantId,
      contractId: '0b6f5e3a-1111-4c1d-9a6e-2f0d8c7b5a41',
      mimeType: 'application/pdf',
    })
  })

  it('refuses a type that is not a contract, and a key outside this environment', () => {
    expect(newContractKey(tenantId, '0b6f5e3a-1111-4c1d-9a6e-2f0d8c7b5a41', 'text/html')).toBeNull()
    // Production's prefix, asked for from dev: appdev must never write among the real contracts.
    expect(
      parseContractKey(`contracts/${tenantId}/0b6f5e3a-1111-4c1d-9a6e-2f0d8c7b5a41.pdf`),
    ).toBeNull()
    expect(parseContractKey('receipts/dev/0b6f5e3a-1111-4c1d-9a6e-2f0d8c7b5a41.pdf')).toBeNull()
  })
})

describe('who may put a contract on file', () => {
  it('is the tenant themselves, or Keoni for them, and nobody else', () => {
    expect(mayHandleContractFor(asTenant(), tenantId)).toBe(true)
    expect(mayHandleContractFor(admin, tenantId)).toBe(true)
    expect(mayHandleContractFor(asOther(), tenantId)).toBe(false)
  })

  it('will not name an upload for somebody else’s contract', async () => {
    expect(await contractUploadPath(asOther() as never, tenantId, 'application/pdf')).toEqual({
      error: 'That is not your contract.',
    })
  })

  it('will not record one either, even with a well-formed key', async () => {
    const key = newContractKey(tenantId, '0b6f5e3a-2222-4c1d-9a6e-2f0d8c7b5a41', 'application/pdf')!
    landed = { sizeBytes: 1000, contentType: 'application/pdf' }
    expect(await recordContract(asOther() as never, key)).toEqual({
      error: 'That is not your contract.',
    })
  })
})

describe('a lease needs a contract', () => {
  const start = () =>
    startLease({
      adminId: admin.id,
      providerId: tenantId,
      roomId: ROOM,
      startsOn: '2026-12-01',
      today: '2026-11-11',
      depositCents: 0,
      depositHeldOutside: true,
    })

  it('refuses to start, and charges nothing, with none on file', async () => {
    const result = await start()
    expect(result).toMatchObject({ error: expect.stringMatching(/no signed contract on file/i) })
    expect(stripe).toHaveLength(0)
  })

  it('records nothing when the file never arrived', async () => {
    const place = await contractUploadPath(asTenant() as never, tenantId, 'application/pdf')
    if ('error' in place) throw new Error(place.error)
    landed = null
    expect(await recordContract(asTenant() as never, place.pathname)).toMatchObject({
      error: expect.stringMatching(/did not arrive/i),
    })
    expect((await getContractState(tenantId)).waiting).toBeNull()
  })

  it('removes a file that is not a contract instead of recording it', async () => {
    const place = await contractUploadPath(asTenant() as never, tenantId, 'application/pdf')
    if ('error' in place) throw new Error(place.error)
    landed = { sizeBytes: 50 * 1024 * 1024, contentType: 'application/pdf' }
    expect(await recordContract(asTenant() as never, place.pathname)).toHaveProperty('error')
    expect(deleted).toEqual([place.pathname])
    expect((await getContractState(tenantId)).waiting).toBeNull()
  })

  it('shows on the tenant’s account whoever uploaded it, and a second upload replaces the first', async () => {
    const first = await upload(admin, tenantId)
    if ('error' in first) throw new Error(first.error)
    expect((await getContractState(tenantId)).waiting).toMatchObject({ byTenant: false })

    const second = await upload(asTenant(), tenantId)
    if ('error' in second) throw new Error(second.error)
    expect((await getContractState(tenantId)).waiting).toMatchObject({ byTenant: true })
    // The replaced file is gone from the store, not just from the list.
    expect(deleted).toEqual([first.pathname])
    const rows = (await sql.query(`SELECT 1 FROM room_contracts WHERE provider_id = $1`, [
      tenantId,
    ])) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('starts on it, ends when it does, and tells Stripe the same day', async () => {
    const result = await start()
    expect(result).toMatchObject({ ok: true })

    const [lease] = (await sql.query(
      `SELECT id, ends_on::text, term_months FROM room_leases WHERE provider_id = $1`,
      [tenantId],
    )) as { id: string; ends_on: string; term_months: number }[]
    leaseId = lease.id
    expect(lease).toMatchObject({ ends_on: '2027-06-01', term_months: 6 })

    const subscribe = stripe.find((c) => c.path === '/subscriptions')!
    // Midnight in Denver on 1 June 2027 (MDT, UTC-6).
    expect(subscribe.body.cancel_at).toBe(Date.UTC(2027, 5, 1, 6) / 1000)

    // The contract is the lease's now: no longer waiting, and it is the current one.
    const state = await getContractState(tenantId)
    expect(state.waiting).toBeNull()
    expect(state.current).not.toBeNull()

    // The mocked Stripe returned no subscription id; give the lease one so it can be renewed.
    await sql.query(`UPDATE room_leases SET stripe_subscription_id = $2 WHERE id = $1`, [leaseId, SUB])
  })
})

describe('a lease runs past six months only on a new contract', () => {
  it('refuses to renew without one', async () => {
    expect(await renewLease(leaseId)).toMatchObject({
      error: expect.stringMatching(/newly signed contract/i),
    })
    expect(stripe).toHaveLength(0)
  })

  it('keeps the contract a lease runs on when a renewal is uploaded', async () => {
    const renewal = await upload(asTenant(), tenantId)
    if ('error' in renewal) throw new Error(renewal.error)
    // Only a WAITING contract is ever replaced. The one in force stays, file and all.
    expect(deleted).toHaveLength(0)
    const state = await getContractState(tenantId)
    expect(state.current).not.toBeNull()
    expect(state.waiting).not.toBeNull()
  })

  it('caps notice at the end of the contract', async () => {
    expect(await recordNotice(leaseId, '2027-05-20')).toMatchObject({
      detail: expect.stringContaining('2027-06-01'),
    })
  })

  it('renews for six more months from the old end, and withdraws the notice', async () => {
    stripe.length = 0
    expect(await renewLease(leaseId)).toMatchObject({ ok: true })

    const [lease] = (await sql.query(
      `SELECT ends_on::text, term_months, notice_given_on FROM room_leases WHERE id = $1`,
      [leaseId],
    )) as { ends_on: string; term_months: number; notice_given_on: string | null }[]
    expect(lease).toEqual({ ends_on: '2027-12-01', term_months: 12, notice_given_on: null })

    expect(stripe).toEqual([
      // Midnight in Denver on 1 December 2027 (MST, UTC-7).
      { path: `/subscriptions/${SUB}`, body: { cancel_at: Date.UTC(2027, 11, 1, 7) / 1000 } },
    ])

    // Both contracts are the lease's; the newer is the current one and nothing is waiting.
    const rows = (await sql.query(
      `SELECT 1 FROM room_contracts WHERE lease_id = $1`,
      [leaseId],
    )) as unknown[]
    expect(rows).toHaveLength(2)
    expect((await getContractState(tenantId)).waiting).toBeNull()
  })

  it('cannot spend the same contract twice', async () => {
    expect(await renewLease(leaseId)).toHaveProperty('error')
  })
})
