import 'server-only'

import { and, eq, ne, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import { denverInstant } from '@/lib/db/queries/availability'
import { getProcessingRate } from '@/lib/db/queries/admin-tools'
import { ledgerEntries, providers, roomLeases, rooms } from '@/lib/db/schema'
import { MELANITE_NOTIFY_EMAIL, deskLeaseDeclinedEmail, leaseDeclinedEmail, sendEmail } from '@/lib/email'
import { grossUpForProcessing, toMoney } from '@/lib/money'
import { StripeApiError, stripeDelete, stripeGet, stripePost } from '@/lib/stripe/client'
import { appOrigin, isMissingCustomerError } from '@/lib/stripe/config'

import { attachContract, waitingContractId } from './contracts'
import { addMonthsYmd, contractEndsOn, endsAfterNotice, leaseSchedule } from './lease-schedule'

/** How long one signed contract runs. A renewal adds this much again. */
const TERM_MONTHS = 6

// Monthly leases for the rooms and nail stations (migration 0049).
//
// Keoni sets a lease up; nobody applies for one. Rent is a Stripe subscription on the tenant's
// saved card — the same card the daily room and the laser charge — prorated for a part-month and
// then taken on the 1st, with Stripe's fee passed to the tenant (4 November 2026).
//
// Every Stripe call here is made by Keoni from the Rooms page, or by a webhook. Nothing is
// charged on a tenant's own click.

const DENVER_MIDNIGHT = '00:00'
const unix = (ymd: string) => Math.floor(denverInstant(ymd, DENVER_MIDNIGHT).getTime() / 1000)

export type LeaseResult = { ok: true; detail: string } | { error: string }

/** The rent and deposit actually charged, with processing on top of what Melanite keeps. */
async function grossed(netCents: number): Promise<number> {
  if (netCents === 0) return 0
  const rate = await getProcessingRate()
  return grossUpForProcessing({ netCents, pct: rate.pct, fixedCents: rate.fixedCents }).chargeCents
}

/** The Stripe product a room's rent is billed under, created the first time it is needed.
 *
 *  Recreated when the stored id is one this key cannot see: once production has rooms, the
 *  nightly copy brings its live product ids into dev, where the test key has never heard of them. */
async function productFor(room: { id: string; name: string; stripeProductId: string | null }) {
  if (room.stripeProductId) return room.stripeProductId
  const product = await stripePost<{ id: string }>(
    '/products',
    { name: `Monthly rent — ${room.name}`, metadata: { room_id: room.id } },
    { idempotencyKey: `room-product:${room.id}:${Date.now()}` },
  )
  await db.update(rooms).set({ stripeProductId: product.id }).where(eq(rooms.id, room.id))
  return product.id
}

const isMissingProduct = (err: unknown) =>
  /no such product/i.test(err instanceof Error ? err.message : String(err))

/**
 * Starts a lease: the deposit, if the app is collecting it, then the rent subscription.
 *
 * Deposit FIRST. If the card cannot take the deposit nothing else happens, and Keoni is told at
 * once rather than discovering a lease that bills rent against a deposit nobody paid. If the
 * deposit goes through and the subscription then fails, the deposit is refunded and the lease
 * removed — a half-started lease is worse than none.
 */
export async function startLease(input: {
  adminId: string
  providerId: string
  roomId: string
  startsOn: string
  today: string
  depositCents: number
  depositHeldOutside: boolean
}): Promise<LeaseResult> {
  const schedule = leaseSchedule(input.startsOn, input.today)
  if ('error' in schedule) return { error: schedule.error }

  if (!Number.isInteger(input.depositCents) || input.depositCents < 0) {
    return { error: 'Enter the deposit as a dollar amount, or 0.' }
  }

  const [room] = await db
    .select({
      id: rooms.id,
      name: rooms.name,
      kind: rooms.kind,
      monthlyPriceCents: rooms.monthlyPriceCents,
      stripeProductId: rooms.stripeProductId,
    })
    .from(rooms)
    .where(and(eq(rooms.id, input.roomId), eq(rooms.active, true)))
    .limit(1)
  if (!room || room.kind !== 'monthly' || !room.monthlyPriceCents) {
    return { error: 'That space is not rented by the month.' }
  }

  const [tenant] = await db
    .select({
      practiceType: providers.practiceType,
      customerId: providers.stripeBillingCustomerId,
      paymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1)
  if (!tenant) return { error: 'That tenant does not exist.' }
  if (!tenant.customerId || !tenant.paymentMethodId) {
    return {
      error:
        'They have no card on file yet. Ask them to add one on their Room Rental page, then start the lease.',
    }
  }

  // No lease without the paper it runs on (11 November). Checked before anything is charged.
  const contractId = await waitingContractId(input.providerId)
  if (!contractId) {
    return {
      error:
        'There is no signed contract on file for them yet. They can upload it on their Room Rental page, or you can upload it for them below.',
    }
  }
  // The lease ends when the contract does. Stripe is told the same day, so rent stops on its own
  // and the last part-month is prorated; a renewal moves both.
  const endsOn = addMonthsYmd(input.startsOn, TERM_MONTHS)

  const monthlyCents = room.monthlyPriceCents
  const rentCharge = await grossed(monthlyCents)
  const depositCharge = input.depositHeldOutside ? 0 : await grossed(input.depositCents)

  let leaseId: string
  try {
    const [row] = await db
      .insert(roomLeases)
      .values({
        createdBy: input.adminId,
        providerId: input.providerId,
        roomId: room.id,
        startsOn: input.startsOn,
        termMonths: TERM_MONTHS,
        endsOn,
        monthlyCents,
        depositCents: input.depositCents,
        depositStatus: input.depositHeldOutside || input.depositCents === 0 ? 'held_outside' : 'charged',
      })
      .returning({ id: roomLeases.id })
    leaseId = row.id
  } catch (err) {
    if (isUniqueViolation(err)) return { error: `${room.name} already has a tenant.` }
    throw err
  }

  const abandon = async () => {
    await db.delete(roomLeases).where(eq(roomLeases.id, leaseId))
  }

  // 1. Deposit.
  let depositIntent: string | null = null
  if (depositCharge > 0) {
    try {
      const pi = await stripePost<{ id: string; status: string }>(
        '/payment_intents',
        {
          amount: depositCharge,
          currency: 'usd',
          customer: tenant.customerId,
          payment_method: tenant.paymentMethodId,
          off_session: true,
          confirm: true,
          description: `Deposit — ${room.name}`,
          metadata: { type: 'room_deposit', lease_id: leaseId, provider_id: input.providerId },
        },
        { idempotencyKey: `lease-deposit:${leaseId}` },
      )
      if (pi.status !== 'succeeded') {
        await abandon()
        return { error: 'The deposit did not go through. Nothing was set up.' }
      }
      depositIntent = pi.id
    } catch (err) {
      await abandon()
      return { error: declineMessage(err, 'The deposit could not be charged. Nothing was set up.') }
    }
  }

  // 2. Rent.
  const subscribe = async (product: string) =>
    stripePost<{ id: string; status: string }>(
      '/subscriptions',
      {
        customer: tenant.customerId,
        default_payment_method: tenant.paymentMethodId,
        off_session: true,
        // A first payment that fails refuses the whole subscription, so a declined card is
        // known now, while Keoni is setting it up, rather than in tomorrow's email.
        payment_behavior: 'error_if_incomplete',
        items: [
          {
            price_data: {
              currency: 'usd',
              product,
              unit_amount: rentCharge,
              recurring: { interval: 'month' },
            },
          },
        ],
        ...(schedule.kind === 'prorate'
          ? {
              billing_cycle_anchor: unix(schedule.anchor),
              proration_behavior: 'create_prorations',
              ...(schedule.backdated ? { backdate_start_date: unix(schedule.periodStart) } : {}),
            }
          : { trial_end: unix(schedule.firstCharge) }),
        cancel_at: unix(endsOn),
        // `plan` is what keeps the invoice webhooks from treating rent as medical direction —
        // see `planFromMetadata`.
        metadata: { plan: 'room_lease', lease_id: leaseId, provider_id: input.providerId },
      },
      { idempotencyKey: `lease-subscribe:${leaseId}` },
    )

  let subscriptionId: string
  try {
    let product = await productFor(room)
    try {
      subscriptionId = (await subscribe(product)).id
    } catch (err) {
      if (!isMissingProduct(err)) throw err
      await db.update(rooms).set({ stripeProductId: null }).where(eq(rooms.id, room.id))
      product = await productFor({ ...room, stripeProductId: null })
      subscriptionId = (await subscribe(product)).id
    }
  } catch (err) {
    if (depositIntent) {
      await stripePost('/refunds', { payment_intent: depositIntent }, {
        idempotencyKey: `lease-deposit-undo:${leaseId}`,
      }).catch((refundErr) =>
        console.error('[lease] could not undo deposit', leaseId, refundErr),
      )
    }
    await abandon()
    if (isMissingCustomerError(err)) {
      return { error: 'Their saved card is no longer valid. Ask them to add it again.' }
    }
    return {
      error: declineMessage(
        err,
        depositIntent
          ? 'The first rent payment failed, so the deposit was refunded and nothing was set up.'
          : 'The first rent payment failed. Nothing was set up.',
      ),
    }
  }

  await db
    .update(roomLeases)
    .set({ status: 'active', stripeSubscriptionId: subscriptionId, depositPaymentIntentId: depositIntent })
    .where(eq(roomLeases.id, leaseId))
  // Last, so a lease that failed to start leaves the contract waiting for the next attempt.
  await attachContract(contractId, leaseId)

  return {
    ok: true,
    detail:
      (schedule.kind === 'future'
        ? `${room.name} is let from ${input.startsOn}. The first rent is taken that day.`
        : `${room.name} is let. The part-month was charged now; full rent comes out on the 1st.`) +
      ` The contract runs to ${endsOn}.`,
  }
}

/**
 * Renews a running lease for another term, on a newly signed contract.
 *
 * The lease is the same lease: same space, same rent, same deposit, no gap and nothing charged.
 * What changes is the day it ends — six months after the day it WOULD have ended, not six months
 * from today, so renewing early does not shorten what the tenant signed for. Notice that had been
 * given is withdrawn by this: a tenant who signs again is staying.
 */
export async function renewLease(leaseId: string): Promise<LeaseResult> {
  const [lease] = await db
    .select({
      status: roomLeases.status,
      providerId: roomLeases.providerId,
      startsOn: roomLeases.startsOn,
      termMonths: roomLeases.termMonths,
      subscriptionId: roomLeases.stripeSubscriptionId,
    })
    .from(roomLeases)
    .where(eq(roomLeases.id, leaseId))
    .limit(1)
  if (!lease || lease.status === 'ended' || !lease.subscriptionId) {
    return { error: 'That lease has ended. Start a new one instead.' }
  }

  const contractId = await waitingContractId(lease.providerId)
  if (!contractId) {
    return { error: 'Upload the newly signed contract first, then renew.' }
  }

  const termMonths = lease.termMonths + TERM_MONTHS
  const endsOn = contractEndsOn({ startsOn: lease.startsOn, termMonths })

  // Stripe first: if it refuses, nothing here has changed and the contract is still waiting.
  await stripePost(`/subscriptions/${lease.subscriptionId}`, { cancel_at: unix(endsOn) })
  await db
    .update(roomLeases)
    .set({ termMonths, endsOn, noticeGivenOn: null })
    .where(eq(roomLeases.id, leaseId))
  await attachContract(contractId, leaseId)

  return { ok: true, detail: `Renewed. The lease now runs to ${endsOn}.` }
}

function declineMessage(err: unknown, fallback: string): string {
  if (err instanceof StripeApiError && err.stripeCode === 'card_declined') {
    return `${fallback} Their card was declined.`
  }
  console.error('[lease]', err)
  return fallback
}

/** Records 30 days' notice. Rent stops at the end date, prorated, and the lease ends there. */
export async function recordNotice(leaseId: string, noticeOn: string): Promise<LeaseResult> {
  const [lease] = await db
    .select({
      status: roomLeases.status,
      subscriptionId: roomLeases.stripeSubscriptionId,
      startsOn: roomLeases.startsOn,
      termMonths: roomLeases.termMonths,
    })
    .from(roomLeases)
    .where(eq(roomLeases.id, leaseId))
    .limit(1)
  if (!lease || lease.status === 'ended' || !lease.subscriptionId) {
    return { error: 'That lease is not running.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(noticeOn)) return { error: 'Choose the day notice was given.' }

  // Never later than the contract's own end: notice shortens a lease, it cannot lengthen one.
  const endsOn = endsAfterNotice(noticeOn, contractEndsOn(lease))
  await stripePost(`/subscriptions/${lease.subscriptionId}`, {
    cancel_at: unix(endsOn),
    proration_behavior: 'create_prorations',
  })
  await db
    .update(roomLeases)
    .set({ noticeGivenOn: noticeOn, endsOn })
    .where(eq(roomLeases.id, leaseId))

  return { ok: true, detail: `Notice recorded. The lease ends on ${endsOn}.` }
}

/** Ends a lease today. For a tenant who did not respond to Keoni's three days' notice. */
export async function endLeaseNow(leaseId: string, today: string): Promise<LeaseResult> {
  const [lease] = await db
    .select({ status: roomLeases.status, subscriptionId: roomLeases.stripeSubscriptionId })
    .from(roomLeases)
    .where(eq(roomLeases.id, leaseId))
    .limit(1)
  if (!lease || lease.status === 'ended') return { error: 'That lease is not running.' }

  if (lease.subscriptionId) {
    try {
      await stripeDelete(`/subscriptions/${lease.subscriptionId}`)
    } catch (err) {
      // Already cancelled in Stripe is the state we want.
      if (!(err instanceof StripeApiError && err.status === 404)) throw err
    }
  }
  await db
    .update(roomLeases)
    .set({ status: 'ended', endsOn: today, endedAt: new Date() })
    .where(eq(roomLeases.id, leaseId))

  return { ok: true, detail: 'The lease has ended and no more rent will be taken.' }
}

/**
 * Keoni's decision on the deposit once a lease has ended.
 *
 * REFUNDED is what Melanite kept — the processing on the deposit charge went to Stripe and is the
 * tenant's, as every fee here is. KEPT becomes revenue, so it gets a ledger row. A deposit held
 * outside the app is only marked: the money was never here.
 */
export async function decideDeposit(leaseId: string, decision: 'refund' | 'keep'): Promise<LeaseResult> {
  const [lease] = await db
    .select({
      status: roomLeases.status,
      providerId: roomLeases.providerId,
      depositCents: roomLeases.depositCents,
      depositStatus: roomLeases.depositStatus,
      depositIntent: roomLeases.depositPaymentIntentId,
    })
    .from(roomLeases)
    .where(eq(roomLeases.id, leaseId))
    .limit(1)
  if (!lease) return { error: 'That lease does not exist.' }
  if (lease.status !== 'ended') return { error: 'Decide the deposit once the lease has ended.' }
  if (lease.depositStatus === 'refunded' || lease.depositStatus === 'kept') {
    return { error: 'The deposit has already been decided.' }
  }

  const collected = lease.depositStatus === 'charged' && lease.depositIntent
  if (decision === 'refund' && collected) {
    await stripePost(
      '/refunds',
      {
        payment_intent: lease.depositIntent,
        amount: lease.depositCents,
        metadata: { reason: 'room_deposit_refund', lease_id: leaseId },
      },
      { idempotencyKey: `lease-deposit-refund:${leaseId}` },
    )
  }
  if (decision === 'keep' && collected && lease.depositCents > 0) {
    const amount = toMoney(lease.depositCents)
    await db.insert(ledgerEntries).values({
      source: 'room_lease',
      payer: 'provider',
      entryType: 'purchase',
      subjectType: 'room_lease',
      subjectId: leaseId,
      providerId: lease.providerId,
      grossAmount: amount,
      tipAmount: '0.00',
      providerPayout: '0.00',
      melaniteCut: amount,
      paymentMethod: 'stripe',
      payoutStatus: 'paid',
      note: 'Deposit kept',
    })
  }

  await db
    .update(roomLeases)
    .set({ depositStatus: decision === 'refund' ? 'refunded' : 'kept', depositDecidedAt: new Date() })
    .where(eq(roomLeases.id, leaseId))

  return {
    ok: true,
    detail:
      decision === 'refund'
        ? collected
          ? 'Deposit refunded to their card.'
          : 'Marked as refunded. It was held outside the app, so return it yourself.'
        : 'Deposit kept.',
  }
}

// ---------------------------------------------------------------------------
// Webhooks. Called from lib/stripe/handlers.ts for anything whose metadata says `room_lease`.
// ---------------------------------------------------------------------------

export interface LeaseInvoice {
  id: string
  amount_paid: number
  amount_due: number
}

/** Rent paid: a ledger row, and the lease back to good standing. */
export async function leaseInvoicePaid(
  invoice: LeaseInvoice,
  leaseId: string,
  feeFor: (cents: number) => Promise<number>,
): Promise<string> {
  const [lease] = await db
    .select({ providerId: roomLeases.providerId })
    .from(roomLeases)
    .where(eq(roomLeases.id, leaseId))
    .limit(1)
  if (!lease) return `no lease ${leaseId}`

  // A deferred lease's first invoice is for nothing — the trial up to its first 1st.
  if (invoice.amount_paid > 0) {
    const gross = toMoney(invoice.amount_paid)
    try {
      await db.insert(ledgerEntries).values({
        source: 'room_lease',
        payer: 'provider',
        entryType: 'purchase',
        subjectType: 'room_lease',
        subjectId: leaseId,
        providerId: lease.providerId,
        grossAmount: gross,
        tipAmount: '0.00',
        providerPayout: '0.00',
        melaniteCut: gross,
        stripeFeeCents: await feeFor(invoice.amount_paid),
        paymentMethod: 'stripe',
        stripeInvoiceId: invoice.id,
        payoutStatus: 'paid',
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      return 'rent already recorded (raced)'
    }
  }

  await db
    .update(roomLeases)
    .set({ status: 'active', pastDueSince: null })
    .where(and(eq(roomLeases.id, leaseId), ne(roomLeases.status, 'ended')))

  return `rent recorded for lease ${leaseId}`
}

/** Rent declined: past due, and Keoni and the tenant told — once, at the transition. */
export async function leaseInvoiceFailed(invoice: LeaseInvoice, leaseId: string): Promise<string> {
  const moved = await db
    .update(roomLeases)
    .set({ status: 'past_due', pastDueSince: new Date() })
    .where(and(eq(roomLeases.id, leaseId), eq(roomLeases.status, 'active')))
    .returning({ providerId: roomLeases.providerId, roomId: roomLeases.roomId })

  if (moved.length === 0) return `lease ${leaseId} already past due or ended`

  try {
    const [row] = await db
      .select({
        firstName: providers.firstName,
        lastName: providers.lastName,
        email: providers.email,
        roomName: rooms.name,
      })
      .from(providers)
      .innerJoin(rooms, eq(rooms.id, moved[0].roomId))
      .where(eq(providers.id, moved[0].providerId))
      .limit(1)

    if (row) {
      const origin = await appOrigin()
      const amount = `$${toMoney(invoice.amount_due)}`
      await sendEmail({
        to: MELANITE_NOTIFY_EMAIL,
        ...deskLeaseDeclinedEmail({
          tenantName: `${row.firstName} ${row.lastName}`,
          roomName: row.roomName,
          amount,
          url: `${origin}/app/admin/rooms`,
        }),
      })
      await sendEmail({
        to: row.email,
        ...leaseDeclinedEmail({
          firstName: row.firstName,
          roomName: row.roomName,
          amount,
          url: `${origin}/app/room-rental`,
        }),
      })
    }
  } catch (err) {
    // Best effort: the status change above is what matters, and it has happened.
    console.error('[lease] decline email failed for', leaseId, err)
  }

  return `lease ${leaseId} past due`
}

/** The subscription ended in Stripe — notice ran out, or Keoni ended it. */
export async function leaseSubscriptionEnded(leaseId: string): Promise<string> {
  await db
    .update(roomLeases)
    .set({
      status: 'ended',
      endedAt: sql`coalesce(${roomLeases.endedAt}, now())`,
    })
    .where(and(eq(roomLeases.id, leaseId), ne(roomLeases.status, 'ended')))
  return `lease ${leaseId} ended`
}

/**
 * Points a tenant's running leases at the card they have just saved.
 *
 * A lease's subscription names its card (`default_payment_method`) when it starts, and that
 * outranks the customer's default. Without this a tenant who replaces a card — usually because
 * rent was declined, and the page tells them to — has every retry go to the dead one.
 *
 * A lease already past due also has its open rent tried on the new card straight away, rather than
 * waiting days for Stripe's next retry. If it pays, `invoice.paid` puts the lease back in good
 * standing as usual; if it declines, the lease simply stays past due.
 *
 * Called from the card-saved webhook, so it must be safe to replay, and it never throws: the card
 * is saved either way, and a lease that could not be moved is logged for Ethan to look at.
 */
export async function moveLeasesToCard(providerId: string, paymentMethodId: string): Promise<void> {
  const live = await db
    .select({ id: roomLeases.id, status: roomLeases.status, sub: roomLeases.stripeSubscriptionId })
    .from(roomLeases)
    .where(and(eq(roomLeases.providerId, providerId), ne(roomLeases.status, 'ended')))

  for (const lease of live) {
    if (!lease.sub) continue
    try {
      await stripePost(`/subscriptions/${lease.sub}`, { default_payment_method: paymentMethodId })
    } catch (err) {
      console.error('[lease] could not move lease', lease.id, 'to the new card', err)
      continue
    }

    if (lease.status !== 'past_due') continue
    try {
      const open = await stripeGet<{ data: { id: string }[] }>(
        `/invoices?subscription=${lease.sub}&status=open`,
      )
      for (const invoice of open.data) {
        await stripePost(`/invoices/${invoice.id}/pay`, { payment_method: paymentMethodId })
      }
    } catch (err) {
      // A decline lands here. The lease stays past due and Stripe keeps retrying, now on this card.
      console.warn('[lease] retry on the new card did not pay for lease', lease.id, err)
    }
  }
}

/** Whether somebody's rent depends on the card on file — and so it must not simply be removed. */
export async function hasLiveLease(providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: roomLeases.id })
    .from(roomLeases)
    .where(and(eq(roomLeases.providerId, providerId), ne(roomLeases.status, 'ended')))
    .limit(1)
  return Boolean(row)
}
