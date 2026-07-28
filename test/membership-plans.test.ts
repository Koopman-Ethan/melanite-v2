import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { planFromMetadata } from '@/lib/stripe/config'
import {
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionChanged,
} from '@/lib/stripe/handlers'
import type { StripeInvoiceObject, StripeSubscriptionObject } from '@/lib/stripe/types'

// Two subscriptions, one provider.
//
// Until Epicutis there was only ever one, and every subscription handler assumed it: they wrote
// to `memberships` scoped by provider alone and flipped `medicalDirectorStatus` on any
// subscription event carrying a provider_id. Harmless with one plan. With two:
//
//   - paying for a $95 content membership would have granted MEDICAL DIRECTION, one of the
//     three booking gates — a compliance problem, not a data one
//   - cancelling it, or failing its card, would have revoked the provider's ability to book
//
// These tests exist to make sure that stays fixed, because nothing about it is visible from
// reading the Epicutis feature itself.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''

const subscription = (
  id: string,
  plan: string | undefined,
  overrides: Partial<StripeSubscriptionObject> = {},
) =>
  ({
    id,
    customer: 'cus_zzplan',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ current_period_end: 1893456000 }] },
    metadata: { provider_id: providerId, ...(plan ? { plan } : {}) },
    ...overrides,
  }) as unknown as StripeSubscriptionObject

const invoice = (id: string, plan: string | undefined, amount = 9500) =>
  ({
    id,
    amount_paid: amount,
    parent: {
      subscription_details: {
        metadata: { provider_id: providerId, ...(plan ? { plan } : {}) },
      },
    },
  }) as unknown as StripeInvoiceObject

async function directorStatus(): Promise<string> {
  const [row] = (await sql.query(
    `SELECT medical_director_status FROM providers WHERE id = $1`,
    [providerId],
  )) as { medical_director_status: string }[]
  return row.medical_director_status
}

async function membership(plan: string) {
  const [row] = (await sql.query(
    `SELECT status, stripe_subscription_id FROM memberships WHERE provider_id = $1 AND plan = $2`,
    [providerId, plan],
  )) as Record<string, string>[]
  return row ?? null
}

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO providers (email, password_hash, requires_password_reset, first_name, last_name,
                            role, status, onboarding_step, booking_enabled, medical_director_type,
                            medical_director_status)
     VALUES ($1, 'x', true, 'Zzplan', 'Subject', 'provider', 'active', 6, true, 'melanite',
             'active')
     RETURNING id`,
    [`zz.plan.${Date.now()}@example.com`],
  )) as { id: string }[]
  providerId = rows[0].id
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM memberships WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
})

describe('planFromMetadata', () => {
  it('reads the plan written at checkout', () => {
    expect(planFromMetadata({ plan: 'epicutis' })).toBe('epicutis')
    expect(planFromMetadata({ plan: 'medical_director' })).toBe('medical_director')
  })

  it('treats anything unlabelled as the director plan', () => {
    // Every subscription created before this existed has no `plan` key. Defaulting the other
    // way would silently stop those renewals from keeping the booking gate open.
    expect(planFromMetadata(null)).toBe('medical_director')
    expect(planFromMetadata({})).toBe('medical_director')
    expect(planFromMetadata({ plan: 'something-else' })).toBe('medical_director')
  })
})

describe('the two plans do not collide', () => {
  it('keeps a separate membership row per plan', async () => {
    await handleSubscriptionChanged(
      subscription('sub_md', 'medical_director'),
      'customer.subscription.created',
    )
    await handleSubscriptionChanged(
      subscription('sub_epi', 'epicutis'),
      'customer.subscription.created',
    )

    // Two rows, each holding its own subscription. Scoped by provider alone, the second event
    // overwrote the first row's subscription id.
    expect((await membership('medical_director')).stripe_subscription_id).toBe('sub_md')
    expect((await membership('epicutis')).stripe_subscription_id).toBe('sub_epi')
  })

  it('does NOT grant medical direction for an Epicutis payment', async () => {
    await sql.query(`UPDATE providers SET medical_director_status = 'none' WHERE id = $1`, [
      providerId,
    ])

    await handleInvoicePaid(invoice('in_epi_1', 'epicutis'))

    // The whole reason these tests exist. $95 of content access is not physician oversight.
    expect(await directorStatus()).toBe('none')
    expect((await membership('epicutis')).status).toBe('active')
  })

  it('still grants medical direction for the director plan', async () => {
    await handleInvoicePaid(invoice('in_md_1', 'medical_director', 15000))
    expect(await directorStatus()).toBe('active')
  })

  it('records the money against the right membership, in its own revenue stream', async () => {
    const rows = (await sql.query(
      `SELECT l.stripe_invoice_id, l.source, m.plan
         FROM ledger_entries l JOIN memberships m ON m.id = l.subject_id
        WHERE l.provider_id = $1 ORDER BY l.stripe_invoice_id`,
      [providerId],
    )) as { stripe_invoice_id: string; source: string; plan: string }[]

    // Each invoice lands on its own plan's row rather than both attaching to whichever
    // membership was created first — and on its own ledger source, so admin revenue can report
    // what Melanite earns supplying medical direction apart from what it earns reselling
    // Epicutis. Summed together they answer a question nobody asked.
    expect(rows).toEqual([
      { stripe_invoice_id: 'in_epi_1', source: 'epicutis', plan: 'epicutis' },
      { stripe_invoice_id: 'in_md_1', source: 'membership', plan: 'medical_director' },
    ])
  })

  it('does NOT close the booking gate when an Epicutis payment fails', async () => {
    await handleInvoicePaymentFailed(invoice('in_epi_fail', 'epicutis'))

    // A declined card on a content subscription must not stop somebody treating clients.
    expect(await directorStatus()).toBe('active')
    expect((await membership('epicutis')).status).toBe('past_due')
    expect((await membership('medical_director')).status).toBe('active')
  })

  it('does NOT revoke booking when Epicutis is cancelled', async () => {
    await handleSubscriptionChanged(
      subscription('sub_epi', 'epicutis', { status: 'canceled' }),
      'customer.subscription.deleted',
    )

    expect(await directorStatus()).toBe('active')
    expect((await membership('epicutis')).status).toBe('cancelled')
    expect((await membership('medical_director')).status).toBe('active')
  })

  it('still revokes booking when the DIRECTOR plan is cancelled', async () => {
    await handleSubscriptionChanged(
      subscription('sub_md', 'medical_director', { status: 'canceled' }),
      'customer.subscription.deleted',
    )
    expect(await directorStatus()).toBe('inactive')
  })
})
