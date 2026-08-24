import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  bookingAccessLostEmail,
  bookingAccessRestoredEmail,
  deskProviderAccessEmail,
} from '@/lib/email'
import {
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionChanged,
} from '@/lib/stripe/handlers'

// What happens when a provider loses the ability to book.
//
// On 2026-08-23 a provider's medical director renewal was declined, `canBook` closed against
// her, and nothing told her or Melanite — it was found a day later in Stripe. These cover the
// two halves of the fix: what the messages say, and the property that decides whether they are
// worth reading at all.
//
// That property is the second describe block. Stripe re-sends `invoice.payment_failed` on every
// dunning retry for two to three weeks, so a notification hung off the EVENT would tell somebody
// six times about one decline. It is hung off the TRANSITION of `medical_director_status`
// instead, and a test that only checked the first call would pass either way.

const LOST = {
  firstName: 'Nichole',
  reason: 'past_due' as const,
  url: 'https://app.melanitesuite.com/app/membership',
}

describe('what the provider is told', () => {
  it('leads with the fact that existing appointments are safe', () => {
    // The difference between a provider updating their billing and a provider ringing every
    // client on their week. It is also simply true — only creating new bookings is gated.
    const mail = bookingAccessLostEmail(LOST)

    expect(mail.text).toContain('not affected')
    expect(mail.html).toContain('not affected')
  })

  it('never calls it a card', () => {
    // The provider this was written for pays by Link, which has no card object at all. "Update
    // your card" sends somebody looking for something that does not exist.
    for (const reason of ['past_due', 'inactive'] as const) {
      const mail = bookingAccessLostEmail({ ...LOST, reason })
      expect(mail.text.toLowerCase()).not.toContain('card')
      expect(mail.html.toLowerCase()).not.toContain('card')
    }
  })

  it('says different things about a decline and a cancelled subscription', () => {
    const pastDue = bookingAccessLostEmail(LOST)
    const inactive = bookingAccessLostEmail({ ...LOST, reason: 'inactive' })

    expect(pastDue.subject).not.toBe(inactive.subject)
    // Only the past-due one has retries left to warn about; the other has already run out.
    expect(pastDue.text).toContain('retried automatically')
    expect(inactive.text).not.toContain('retried automatically')
    expect(inactive.text).toContain('ended')
  })

  it('points at the page that can fix it', () => {
    expect(bookingAccessLostEmail(LOST).text).toContain('/app/membership')
    expect(bookingAccessLostEmail(LOST).html).toContain('/app/membership')
  })

  it('closes the loop when access comes back', () => {
    const mail = bookingAccessRestoredEmail({
      firstName: 'Nichole',
      url: 'https://app.melanitesuite.com/app',
    })

    expect(mail.subject).toContain('back on')
    expect(mail.text).toContain('Nichole')
  })
})

describe("what Melanite is told", () => {
  const BASE = {
    event: 'lost' as const,
    providerName: 'Nichole Mim',
    reason: 'past_due' as const,
    canSelfServe: true,
    url: 'https://app.melanitesuite.com/app/admin/providers',
  }

  it('names the provider in the subject', () => {
    expect(deskProviderAccessEmail(BASE).subject).toBe('Booking paused: Nichole Mim')
    expect(deskProviderAccessEmail({ ...BASE, event: 'restored' }).subject).toBe(
      'Booking restored: Nichole Mim',
    )
  })

  it('says whether this one is hers to deal with', () => {
    // The line Keoni acts on. A provider with a billing customer can fix it in the portal; one
    // without cannot, however clearly the email is written, and needs her.
    const selfServe = deskProviderAccessEmail(BASE)
    const stuck = deskProviderAccessEmail({ ...BASE, canSelfServe: false })

    expect(selfServe.text).toContain('Nothing is needed from you')
    expect(stuck.text).toContain('CANNOT fix this themselves')
    expect(stuck.html).toContain('CANNOT fix this themselves')
  })

  it('asks nothing of her when access is restored', () => {
    const mail = deskProviderAccessEmail({ ...BASE, event: 'restored', reason: 'active' })
    expect(mail.text).not.toContain('needs you')
    expect(mail.text).toContain('been told')
  })
})

// ---------------------------------------------------------------------------
// The property that decides whether any of the above is worth receiving.
// ---------------------------------------------------------------------------
//
// EXPECTED STDERR. These tests print "[email] booking access ... alert failed ... `headers` was
// called outside a request scope", once per transition. That is the notifier being reached and
// swallowing the failure exactly as it is supposed to: `appOrigin()` reads request headers to
// build the link, and there is no request here. In production every caller is inside one — the
// Stripe webhook route and the admin server action both are.
//
// Do not read it as a failure, and do not silence it: the presence of that line, and its
// absence on the replayed retries, is itself evidence that the notification fires once per
// transition rather than once per event.

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL!)

let providerId = ''

/** Shaped on the REAL event stored in production's `webhook_events`, not invented.
 *
 *  Two details an invented fixture would have got wrong: `provider_id` arrives on
 *  `parent.subscription_details.metadata` rather than on the payment intent, which carries no
 *  metadata at all; and there is no `plan` key, so `planFromMetadata` falls through to
 *  `medical_director`. Both are load-bearing. */
const invoiceFor = (id: string, invoiceId: string) =>
  ({
    id: invoiceId,
    amount_paid: 15000,
    amount_due: 15000,
    parent: { subscription_details: { metadata: { provider_id: id } } },
    lines: { data: [{ metadata: { provider_id: id } }] },
  }) as never

const statusOf = async () => {
  const rows = (await sql.query(
    `SELECT medical_director_status AS s FROM providers WHERE id = $1`,
    [providerId],
  )) as { s: string }[]
  return rows[0].s
}

beforeAll(async () => {
  const rows = (await sql.query(
    `INSERT INTO providers (email, first_name, last_name, role, status, onboarding_step,
                            booking_enabled, medical_director_status)
     VALUES ($1, 'Zzaccess', 'Subject', 'provider', 'active', 6, true, 'active')
     RETURNING id`,
    // example.com is refused outright by sendEmail's reserved-domain guard, so nothing this
    // test does can reach a real inbox even if the notifier runs.
    [`zz.access.${Date.now()}@example.com`],
  )) as { id: string }[]
  providerId = rows[0].id

  // A provider on the director plan HAS a membership row — `handleSubscriptionChanged` upserts
  // one when the subscription is created. Giving the fixture one matters beyond realism:
  // `handleInvoicePaid` writes its ledger entry with `subjectId: membership?.id ?? providerId`,
  // so a fixture without one produces a `subject_type = 'membership'` row pointing at a
  // PROVIDER — the exact shape `ledger-invariants` exists to catch, manufactured by the test
  // that is supposed to be testing something else.
  await sql.query(
    `INSERT INTO memberships (provider_id, plan, status) VALUES ($1, 'medical_director', 'active')`,
    [providerId],
  )
})

beforeEach(async () => {
  await sql.query(`UPDATE providers SET medical_director_status = 'active' WHERE id = $1`, [
    providerId,
  ])
})

afterAll(async () => {
  await sql.query(`DELETE FROM ledger_entries WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM memberships WHERE provider_id = $1`, [providerId])
  await sql.query(`DELETE FROM providers WHERE id = $1`, [providerId])
})

describe('one decline, one notification', () => {
  it('reports a transition the first time and a no-op after that', async () => {
    const invoice = invoiceFor(providerId, `in_zz_${Date.now()}`)

    const first = await handleInvoicePaymentFailed(invoice)
    expect(await statusOf()).toBe('past_due')
    expect(first.detail).toContain('booking access paused')

    // Every dunning retry re-delivers this same event. The status is already past_due, so
    // nothing moved and nobody is told again — which is the whole point.
    for (let i = 0; i < 3; i++) {
      const again = await handleInvoicePaymentFailed(invoice)
      expect(again.handled).toBe(true)
      expect(again.detail).toContain('already past due')
      expect(again.detail).not.toContain('booking access paused')
    }

    expect(await statusOf()).toBe('past_due')
  })

  it('still closes the gate, whatever it says about notifying', async () => {
    // The notification is the new behaviour; the gate closing is the behaviour that was already
    // right and must not be broken by making the update conditional.
    await handleInvoicePaymentFailed(invoiceFor(providerId, `in_zz_${Date.now()}`))
    expect(await statusOf()).toBe('past_due')
  })
})

describe('paying restores it, once', () => {
  it('reopens the gate on the invoice that actually reopens it', async () => {
    await handleInvoicePaymentFailed(invoiceFor(providerId, `in_zz_${Date.now()}`))
    expect(await statusOf()).toBe('past_due')

    const paid = await handleInvoicePaid(invoiceFor(providerId, `in_zz_paid_${Date.now()}`))
    expect(await statusOf()).toBe('active')
    expect(paid.detail).toContain('booking access restored')
  })

  it('says nothing on an ordinary invoice for a provider who was never blocked', async () => {
    // The common case by a wide margin: a monthly renewal succeeding while everything is fine.
    // "Your booking access has been restored" for a provider who never lost it is noise, and
    // noise is what teaches somebody to ignore the message that matters.
    const paid = await handleInvoicePaid(invoiceFor(providerId, `in_zz_ok_${Date.now()}`))

    expect(await statusOf()).toBe('active')
    expect(paid.detail).not.toContain('booking access restored')
  })
})

describe('a subscription that ends for good', () => {
  const subFor = (id: string, ended: boolean) =>
    ({
      id: `sub_zz_${id.slice(0, 8)}`,
      status: ended ? 'canceled' : 'active',
      customer: 'cus_zz_test',
      cancel_at_period_end: false,
      canceled_at: ended ? Math.floor(Date.now() / 1000) : null,
      metadata: { provider_id: id },
      items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] },
    }) as never

  it('closes the gate once and says so', async () => {
    const result = await handleSubscriptionChanged(
      subFor(providerId, true),
      'customer.subscription.deleted',
    )

    expect(await statusOf()).toBe('inactive')
    expect(result.detail).toContain('booking access ended')
  })

  it('says nothing the second time the same cancellation arrives', async () => {
    await handleSubscriptionChanged(subFor(providerId, true), 'customer.subscription.deleted')
    const again = await handleSubscriptionChanged(
      subFor(providerId, true),
      'customer.subscription.deleted',
    )

    expect(await statusOf()).toBe('inactive')
    expect(again.detail).not.toContain('booking access ended')
  })

  it('leaves the gate alone for an ordinary update', async () => {
    // Two of the three events Stripe sent on 2026-08-23 were subscription.updated. They write
    // the membership row and must NOT touch the provider gate or send anything — that is the
    // whole reason the notification hangs off the gate column rather than off the event.
    const result = await handleSubscriptionChanged(
      subFor(providerId, false),
      'customer.subscription.updated',
    )

    expect(await statusOf()).toBe('active')
    expect(result.detail).not.toContain('booking access')
  })
})
