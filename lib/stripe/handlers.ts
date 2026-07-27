import 'server-only'

import { and, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  checkoutLinks,
  clientPackageItems,
  clientPackages,
  clients,
  ledgerEntries,
  memberships,
  packageCheckoutLinks,
  packageTemplateItems,
  packageTemplates,
  platformSettings,
  providerServices,
  providers,
  roomBookings,
} from '@/lib/db/schema'

import { stripeGet } from './client'
import type {
  StripeAccountObject,
  StripeChargeObject,
  StripeEvent,
  StripeInvoiceObject,
  StripePaymentIntentObject,
  StripePaymentMethodObject,
  StripePayoutObject,
  StripeSubscriptionObject,
} from './types'

// Webhook handlers — the only place in v2 that turns a real Stripe event into money.
//
// v1 split this across four endpoints (platform, connect, package, room), each re-implementing
// the same preamble and each drifting slightly. One endpoint here, dispatching on event type
// and metadata.type.
//
// The two rules everything below obeys:
//
//  1. IDEMPOTENCY IS AT THE PAYMENT INTENT, not the event. Stripe retries aggressively and
//     will happily send two different events for the same charge. v1 got this right and it is
//     worth restating: guarding on event id alone would let a retry under a different event
//     write a second ledger row.
//  2. SPLITS ARE COMPUTED AT WRITE TIME AND PERSISTED. A later change to
//     platform_settings.provider_share_pct must never retroactively rewrite what a provider
//     earned.

export interface HandlerResult {
  handled: boolean
  detail: string
}

const money = (cents: number) => (cents / 100).toFixed(2)

/** True when a ledger row already exists for this payment intent and entry type. */
async function alreadyRecorded(
  paymentIntentId: string,
  entryType: 'purchase' | 'refund',
): Promise<boolean> {
  const [row] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.stripePaymentIntentId, paymentIntentId),
        eq(ledgerEntries.entryType, entryType),
      ),
    )
    .limit(1)

  return Boolean(row)
}

async function providerShare(): Promise<number> {
  const [settings] = await db
    .select({ pct: platformSettings.providerSharePct })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return Number(settings?.pct ?? 0.5)
}

// ---------------------------------------------------------------------------
// payment_intent.succeeded
// ---------------------------------------------------------------------------

/** Records the card the client agreed to leave on file.
 *
 *  Done here, from the webhook, rather than on the page: the payment is only real once Stripe
 *  says so, and a card recorded from a client-side success callback would survive a payment
 *  that later failed. The consent timestamp is written in the same breath as the card, because
 *  a card with no record of consent is not usable for the thing it was collected for.
 *
 *  A failure here must never fail the payment — the money moved regardless. It is logged and
 *  swallowed, leaving the client without a card on file, which is recoverable; throwing would
 *  make Stripe retry an event whose ledger entry is already written.
 */
async function persistSavedCard(pi: StripePaymentIntentObject): Promise<void> {
  const clientId = pi.metadata?.client_id
  if (!clientId || pi.metadata?.save_card !== '1' || !pi.payment_method) return

  try {
    const pm = await stripeGet<StripePaymentMethodObject>(`/payment_methods/${pi.payment_method}`)

    await db
      .update(clients)
      .set({
        defaultPaymentMethodId: pm.id,
        paymentMethodType: pm.type,
        // Null for anything that is not a card. Stripe Link, for instance, exposes only an
        // email — writing "•••• ????" would be describing a card that does not exist.
        cardBrand: pm.card?.brand ?? null,
        cardLast4: pm.card?.last4 ?? null,
        cardExpMonth: pm.card?.exp_month ?? null,
        cardExpYear: pm.card?.exp_year ?? null,
        cardOnFileConsentAt: new Date(),
        cardOnFileConsentVersion: pi.metadata?.card_policy_version ?? null,
        ...(pi.customer ? { stripeCustomerId: pi.customer } : {}),
      })
      .where(eq(clients.id, clientId))
  } catch (err) {
    console.error('[stripe] could not record saved card for client', clientId, err)
  }
}

export async function handlePaymentIntentSucceeded(
  pi: StripePaymentIntentObject,
): Promise<HandlerResult> {
  const kind = pi.metadata?.type

  await persistSavedCard(pi)

  switch (kind) {
    case 'booking_payment':
      return bookingPaid(pi)
    case 'room_rental':
      return roomRentalPaid(pi)
    case 'package_purchase':
      return packagePurchased(pi)
    case 'training_deposit':
    case 'training_balance':
      return trainingPaid(pi, kind)
    // Fees are charged synchronously and their ledger entry is written at that moment, so the
    // webhook has nothing to add. Acknowledged explicitly rather than falling through to
    // "unrecognised", which would log an error for something working exactly as designed.
    case 'no_show_fee':
    case 'late_cancellation_fee':
      return { handled: true, detail: `${kind} recorded at charge time` }
    default:
      // Never guess. An unrecognised intent is logged and left alone rather than being
      // shoehorned into a source, which would put money against the wrong stream.
      return { handled: false, detail: `unrecognised metadata.type: ${kind ?? '(none)'}` }
  }
}

async function bookingPaid(pi: StripePaymentIntentObject): Promise<HandlerResult> {
  if (await alreadyRecorded(pi.id, 'purchase')) {
    return { handled: true, detail: 'already recorded' }
  }

  const bookingId = pi.metadata?.booking_id
  if (!bookingId) return { handled: false, detail: 'booking_payment with no booking_id' }

  const [booking] = await db
    .select({
      id: bookings.id,
      providerId: bookings.providerId,
      clientId: bookings.clientId,
      price: bookings.price,
      providerServiceId: bookings.providerServiceId,
    })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { handled: false, detail: `booking ${bookingId} not found` }

  const [link] = await db
    .select({ id: checkoutLinks.id, tipAmount: checkoutLinks.tipAmount })
    .from(checkoutLinks)
    .where(eq(checkoutLinks.bookingId, bookingId))
    .limit(1)

  const tip = Number(link?.tipAmount ?? 0)
  const gross = Number(booking.price)
  const share = await providerShare()

  // v1's split, kept exactly: the provider's share of the price PLUS the whole tip. Melanite
  // takes no cut of a tip. gross excludes the tip in v2's convention.
  const providerPayout = Number((gross * share + tip).toFixed(2))
  const melaniteCut = Number((gross - gross * share).toFixed(2))

  const serviceId = await serviceIdFor(booking.providerServiceId)

  await db.insert(ledgerEntries).values({
    source: 'booking',
    payer: 'client',
    entryType: 'purchase',
    subjectType: 'booking',
    subjectId: booking.id,
    providerId: booking.providerId,
    clientId: booking.clientId,
    serviceId,
    grossAmount: gross.toFixed(2),
    tipAmount: tip.toFixed(2),
    providerPayout: providerPayout.toFixed(2),
    melaniteCut: melaniteCut.toFixed(2),
    paymentMethod: 'stripe',
    stripePaymentIntentId: pi.id,
    payoutStatus: 'pending',
  })

  if (link) {
    await db
      .update(checkoutLinks)
      .set({ status: 'paid', paidAt: new Date(), stripePaymentIntentId: pi.id })
      .where(eq(checkoutLinks.id, link.id))
  }

  return { handled: true, detail: `booking ${bookingId} paid` }
}

async function serviceIdFor(providerServiceId: string): Promise<string | null> {
  const [row] = await db
    .select({ serviceId: providerServices.serviceId })
    .from(providerServices)
    .where(eq(providerServices.id, providerServiceId))
    .limit(1)

  return row?.serviceId ?? null
}

/** Room rental: the PROVIDER pays Melanite, so there is no split.
 *
 *  The rental row already exists as a `pending` hold created before checkout — this confirms it
 *  rather than discovering it. Two earlier bugs are worth remembering:
 *
 *  1. It fell back to `subjectId: pi.id` when no row matched. `subject_id` is a uuid column and
 *     `pi_3Abc…` is not a uuid, so the "safe" fallback was the one path guaranteed to throw.
 *  2. It matched on (provider, rental_date) with no slot, so a provider holding both `am` and
 *     `pm` on one day could have either payment confirm the wrong block.
 *
 *  Both are fixed by carrying `room_booking_id` in the PaymentIntent metadata. Without a
 *  resolvable rental there is nothing honest to attribute the money to, so it is left
 *  unhandled for replay rather than written against a guess.
 */
async function roomRentalPaid(pi: StripePaymentIntentObject): Promise<HandlerResult> {
  if (await alreadyRecorded(pi.id, 'purchase')) {
    return { handled: true, detail: 'already recorded' }
  }

  const providerId = pi.metadata?.provider_id ?? null
  const roomBookingId = pi.metadata?.room_booking_id ?? null
  const gross = money(pi.amount_received)

  const [rental] = roomBookingId
    ? await db
        .select({ id: roomBookings.id })
        .from(roomBookings)
        .where(eq(roomBookings.id, roomBookingId))
        .limit(1)
    : []

  if (!rental) {
    return { handled: false, detail: `no room booking for ${pi.id}` }
  }

  await db.insert(ledgerEntries).values({
    source: 'room_rental',
    payer: 'provider',
    entryType: 'purchase',
    subjectType: 'room_booking',
    subjectId: rental.id,
    providerId,
    grossAmount: gross,
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: gross,
    paymentMethod: 'stripe',
    stripePaymentIntentId: pi.id,
    payoutStatus: 'paid',
  })

  // `holdExpiresAt` is cleared because the hold is over — it is now a paid booking. The sweep
  // filters on `status = 'pending'` and would skip this row regardless, but leaving a stale
  // expiry on a confirmed rental invites a future sweep that forgets to.
  await db
    .update(roomBookings)
    .set({ status: 'confirmed', stripePaymentIntentId: pi.id, holdExpiresAt: null })
    .where(eq(roomBookings.id, rental.id))

  return { handled: true, detail: 'room rental recorded' }
}

/** Package purchase: creates the client's package instance AND its ledger entry.
 *
 *  The instance items are SNAPSHOTTED from the template, so a later template edit never
 *  rewrites what someone bought — v1's design, and the reason editing a template is safe. */
async function packagePurchased(pi: StripePaymentIntentObject): Promise<HandlerResult> {
  if (await alreadyRecorded(pi.id, 'purchase')) {
    return { handled: true, detail: 'already recorded' }
  }

  const templateId = pi.metadata?.package_template_id
  const clientId = pi.metadata?.client_id
  const providerId = pi.metadata?.provider_id
  if (!templateId || !providerId) {
    return { handled: false, detail: 'package_purchase missing template or provider' }
  }

  const [template] = await db
    .select({
      id: packageTemplates.id,
      totalPrice: packageTemplates.totalPrice,
      expiresAfterDays: packageTemplates.expiresAfterDays,
    })
    .from(packageTemplates)
    .where(eq(packageTemplates.id, templateId))
    .limit(1)

  if (!template) return { handled: false, detail: `template ${templateId} not found` }

  const lines = await db
    .select({
      serviceId: packageTemplateItems.serviceId,
      quantity: packageTemplateItems.quantity,
      perSessionValue: packageTemplateItems.perSessionValue,
    })
    .from(packageTemplateItems)
    .where(eq(packageTemplateItems.packageTemplateId, templateId))

  const tip = Number(pi.metadata?.tip_amount ?? 0)
  // v1's package ledger stored gross INCLUDING the tip; v2 normalised to gross excluding it,
  // so the tip is subtracted back out here rather than carried forward.
  const gross = Number((pi.amount_received / 100 - tip).toFixed(2))
  const share = await providerShare()
  const providerPayout = Number((gross * share + tip).toFixed(2))
  const melaniteCut = Number((gross - gross * share).toFixed(2))

  const [instance] = await db
    .insert(clientPackages)
    .values({
      providerId,
      clientId: clientId!,
      packageTemplateId: templateId,
      status: 'active',
      purchasedAt: new Date(),
      expiresAt: template.expiresAfterDays
        ? new Date(Date.now() + template.expiresAfterDays * 24 * 60 * 60 * 1000)
        : null,
    })
    .returning({ id: clientPackages.id })

  if (lines.length > 0) {
    await db.insert(clientPackageItems).values(
      lines.map((l) => ({
        clientPackageId: instance.id,
        serviceId: l.serviceId,
        perSessionValue: l.perSessionValue,
        qtyTotal: l.quantity,
        qtyUsed: 0,
      })),
    )
  }

  await db.insert(ledgerEntries).values({
    source: 'package',
    payer: 'client',
    entryType: 'purchase',
    subjectType: 'client_package',
    subjectId: instance.id,
    providerId,
    clientId: clientId ?? null,
    grossAmount: gross.toFixed(2),
    tipAmount: tip.toFixed(2),
    providerPayout: providerPayout.toFixed(2),
    melaniteCut: melaniteCut.toFixed(2),
    paymentMethod: 'stripe',
    stripePaymentIntentId: pi.id,
    // A package purchase is a destination charge that settles immediately, so "pending"
    // would be false — v1 keeps these out of pending payout for the same reason.
    payoutStatus: 'paid',
  })

  // Close the link out and point it at what it produced. Without this a paid link stays
  // "pending" forever, so the client could open it again and be shown a second payment form.
  const linkId = pi.metadata?.package_checkout_link_id
  if (linkId) {
    await db
      .update(packageCheckoutLinks)
      .set({
        status: 'paid',
        paidAt: new Date(),
        stripePaymentIntentId: pi.id,
        clientPackageId: instance.id,
      })
      .where(eq(packageCheckoutLinks.id, linkId))
  }

  return { handled: true, detail: `package instance ${instance.id} created` }
}

/** Training: the student pays Melanite. 100% platform, no split. */
async function trainingPaid(
  pi: StripePaymentIntentObject,
  kind: 'training_deposit' | 'training_balance',
): Promise<HandlerResult> {
  if (await alreadyRecorded(pi.id, 'purchase')) {
    return { handled: true, detail: 'already recorded' }
  }

  const enrollmentId = pi.metadata?.training_enrollment_id
  if (!enrollmentId) return { handled: false, detail: 'training payment with no enrollment id' }

  const gross = money(pi.amount_received)

  await db.insert(ledgerEntries).values({
    source: 'training',
    payer: 'student',
    entryType: 'purchase',
    subjectType: 'training_enrollment',
    subjectId: enrollmentId,
    providerId: null,
    grossAmount: gross,
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: gross,
    paymentMethod: 'stripe',
    stripePaymentIntentId: pi.id,
    payoutStatus: 'paid',
    note: kind === 'training_deposit' ? 'Deposit' : 'Balance',
  })

  return { handled: true, detail: `${kind} recorded` }
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

/** Refunds, for EVERY source.
 *
 *  v1's platform webhook only ever handled training here, so a refunded booking left the
 *  ledger untouched and revenue overstated permanently. This handles all of them.
 *
 *  amount_refunded is CUMULATIVE, so the delta against what is already recorded is written —
 *  repeated partial refunds each land once and retries are no-ops.
 */
export async function handleChargeRefunded(charge: StripeChargeObject): Promise<HandlerResult> {
  const paymentIntentId = charge.payment_intent
  if (!paymentIntentId) return { handled: false, detail: 'refund with no payment intent' }

  const [original] = await db
    .select({
      source: ledgerEntries.source,
      payer: ledgerEntries.payer,
      subjectType: ledgerEntries.subjectType,
      subjectId: ledgerEntries.subjectId,
      providerId: ledgerEntries.providerId,
      clientId: ledgerEntries.clientId,
      serviceId: ledgerEntries.serviceId,
      grossAmount: ledgerEntries.grossAmount,
      tipAmount: ledgerEntries.tipAmount,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.stripePaymentIntentId, paymentIntentId),
        eq(ledgerEntries.entryType, 'purchase'),
      ),
    )
    .limit(1)

  if (!original) {
    return { handled: false, detail: `no purchase recorded for ${paymentIntentId}` }
  }

  const [prior] = await db
    .select({
      refunded: sql<string>`coalesce(sum(-(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount})), 0)`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.stripePaymentIntentId, paymentIntentId),
        eq(ledgerEntries.entryType, 'refund'),
      ),
    )

  const target = charge.amount_refunded / 100
  const delta = Number((target - Number(prior?.refunded ?? 0)).toFixed(2))

  if (delta <= 0) return { handled: true, detail: 'refund already recorded' }

  // VERIFIED against live data: transfer_reversal is null on the real refund, so the provider
  // KEEPS their share and the platform absorbs the whole amount. That deliberately breaks the
  // cut + payout == gross + tip identity that holds for purchases.
  await db.insert(ledgerEntries).values({
    source: original.source,
    payer: original.payer,
    entryType: 'refund',
    subjectType: original.subjectType,
    subjectId: original.subjectId,
    providerId: original.providerId,
    clientId: original.clientId,
    serviceId: original.serviceId,
    grossAmount: (-delta).toFixed(2),
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: (-delta).toFixed(2),
    paymentMethod: 'stripe',
    stripePaymentIntentId: paymentIntentId,
    stripeRefundId: charge.id,
    payoutStatus: 'paid',
    note: 'Refund recorded from Stripe.',
  })

  return { handled: true, detail: `refund of ${delta.toFixed(2)} recorded` }
}

// ---------------------------------------------------------------------------
// Subscriptions — the medical director gate
// ---------------------------------------------------------------------------

/** An invoice paid against a subscription. This is membership revenue, which in v1 existed
 *  ONLY in Stripe and never reached any table. */
export async function handleInvoicePaid(invoice: StripeInvoiceObject): Promise<HandlerResult> {
  const providerId =
    invoice.parent?.subscription_details?.metadata?.provider_id ??
    invoice.lines?.data?.[0]?.metadata?.provider_id ??
    null

  if (!providerId) return { handled: false, detail: 'invoice with no provider_id in metadata' }

  const [existing] = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.stripeInvoiceId, invoice.id))
    .limit(1)

  if (existing) return { handled: true, detail: 'invoice already recorded' }

  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.providerId, providerId))
    .limit(1)

  const gross = money(invoice.amount_paid)

  await db.insert(ledgerEntries).values({
    source: 'membership',
    payer: 'provider',
    entryType: 'purchase',
    subjectType: 'membership',
    subjectId: membership?.id ?? providerId,
    providerId,
    grossAmount: gross,
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: gross,
    paymentMethod: 'stripe',
    stripeInvoiceId: invoice.id,
    payoutStatus: 'paid',
  })

  // Paying restores the gate. This is the line that turns a subscription into the ability to
  // book — without it, the whole membership flow is decorative.
  await db
    .update(providers)
    .set({ medicalDirectorStatus: 'active' })
    .where(eq(providers.id, providerId))

  await db
    .update(memberships)
    .set({ status: 'active' })
    .where(eq(memberships.providerId, providerId))

  return { handled: true, detail: `membership invoice recorded for ${providerId}` }
}

export async function handleInvoicePaymentFailed(
  invoice: StripeInvoiceObject,
): Promise<HandlerResult> {
  const providerId =
    invoice.parent?.subscription_details?.metadata?.provider_id ??
    invoice.lines?.data?.[0]?.metadata?.provider_id ??
    null

  if (!providerId) return { handled: false, detail: 'invoice with no provider_id in metadata' }

  await db
    .update(providers)
    .set({ medicalDirectorStatus: 'past_due' })
    .where(eq(providers.id, providerId))

  await db
    .update(memberships)
    .set({ status: 'past_due' })
    .where(eq(memberships.providerId, providerId))

  return { handled: true, detail: `${providerId} marked past_due` }
}

/** Covers created / updated / deleted. v1 subscribed to customer.subscription.updated but had
 *  NO handler for it, so cancel_at_period_end toggles and reactivations were silently lost. */
export async function handleSubscriptionChanged(
  sub: StripeSubscriptionObject,
  eventType: string,
): Promise<HandlerResult> {
  const providerId = sub.metadata?.provider_id ?? null
  if (!providerId) return { handled: false, detail: 'subscription with no provider_id' }

  const ended = eventType === 'customer.subscription.deleted' || sub.status === 'canceled'
  const renewalDate = sub.items?.data?.[0]?.current_period_end
    ? new Date(sub.items.data[0].current_period_end * 1000)
    : null

  const fields = {
    status: (ended ? 'cancelled' : sub.status === 'past_due' ? 'past_due' : 'active') as
      | 'cancelled'
      | 'past_due'
      | 'active',
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    renewalDate,
    cancelDate: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    stripeSubscriptionId: sub.id,
    stripeCustomerId: sub.customer,
  }

  // UPSERT, not update.
  //
  // An update alone affects zero rows when no membership exists yet, which is the normal case
  // for a first subscription: the row was previously only created by
  // checkout.session.completed, so a subscription started any other way — an admin creating
  // one in the Stripe dashboard, a migration, a plan change — opened the booking gate and
  // left no record of the plan behind it. Caught by driving a real sandbox subscription
  // through the API rather than through Checkout.
  //
  // subscription.created is the authoritative event for "this subscription exists", so it is
  // the right place to guarantee the row.
  const updated = await db
    .update(memberships)
    .set(fields)
    .where(eq(memberships.providerId, providerId))
    .returning({ id: memberships.id })

  if (updated.length === 0) {
    await db.insert(memberships).values({
      providerId,
      plan: 'medical_director',
      startDate: new Date(),
      ...fields,
    })
  }

  // Only a genuinely ended subscription closes the gate. cancel_at_period_end means they keep
  // access until the period runs out, so flipping the status now would cut them off early.
  if (ended) {
    await db
      .update(providers)
      .set({ medicalDirectorStatus: 'inactive' })
      .where(eq(providers.id, providerId))
  }

  return { handled: true, detail: `subscription ${sub.id} -> ${ended ? 'ended' : sub.status}` }
}

// ---------------------------------------------------------------------------
// Connect — payouts and onboarding
// ---------------------------------------------------------------------------

/** v1's approximation, kept: Stripe does not map a payout back to the payment intents it
 *  covers in a usable way, so every pending row for that provider is swept. */
export async function handlePayout(
  payout: StripePayoutObject,
  connectedAccountId: string | undefined,
  outcome: 'paid' | 'failed',
): Promise<HandlerResult> {
  if (!connectedAccountId) return { handled: false, detail: 'payout event with no account' }

  const [provider] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.stripeAccountId, connectedAccountId))
    .limit(1)

  if (!provider) return { handled: false, detail: `no provider for ${connectedAccountId}` }

  const payoutDate = new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)

  const updated = await db
    .update(ledgerEntries)
    .set(
      outcome === 'paid'
        ? { payoutStatus: 'paid', payoutDate, payoutMethod: 'stripe_connect' }
        : { payoutStatus: 'failed' },
    )
    .where(
      and(
        eq(ledgerEntries.providerId, provider.id),
        eq(ledgerEntries.payoutStatus, 'pending'),
      ),
    )
    .returning({ id: ledgerEntries.id })

  return { handled: true, detail: `${updated.length} entries -> ${outcome}` }
}

export async function handleAccountUpdated(
  account: StripeAccountObject,
): Promise<HandlerResult> {
  const complete = account.charges_enabled && account.payouts_enabled

  const updated = await db
    .update(providers)
    .set({ stripeOnboardingComplete: complete })
    .where(eq(providers.stripeAccountId, account.id))
    .returning({ id: providers.id })

  if (updated.length === 0) return { handled: false, detail: `no provider for ${account.id}` }

  return { handled: true, detail: `onboarding complete: ${complete}` }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatch(event: StripeEvent): Promise<HandlerResult> {
  const object = event.data.object

  switch (event.type) {
    case 'payment_intent.succeeded':
      return handlePaymentIntentSucceeded(object as unknown as StripePaymentIntentObject)

    case 'charge.refunded':
      return handleChargeRefunded(object as unknown as StripeChargeObject)

    case 'invoice.payment_succeeded':
      return handleInvoicePaid(object as unknown as StripeInvoiceObject)

    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(object as unknown as StripeInvoiceObject)

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionChanged(
        object as unknown as StripeSubscriptionObject,
        event.type,
      )

    case 'payout.paid':
      return handlePayout(object as unknown as StripePayoutObject, event.account, 'paid')

    case 'payout.failed':
      return handlePayout(object as unknown as StripePayoutObject, event.account, 'failed')

    case 'account.updated':
      return handleAccountUpdated(object as unknown as StripeAccountObject)

    default:
      // Subscribed-but-unhandled is a real failure mode — v1 subscribed to
      // customer.subscription.updated and silently dropped every one. Saying so in the log
      // makes it visible instead.
      return { handled: false, detail: `no handler for ${event.type}` }
  }
}

/** Exported for the checkout.session.completed path, which only needs to link the Stripe
 *  customer to the provider — the invoice event does the money. */
export async function linkSubscriptionCustomer(
  providerId: string,
  customerId: string | null,
  subscriptionId: string | null,
): Promise<void> {
  if (customerId) {
    await db
      .update(providers)
      .set({ stripeBillingCustomerId: customerId })
      .where(eq(providers.id, providerId))
  }

  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.providerId, providerId))
    .limit(1)

  if (!existing) {
    await db.insert(memberships).values({
      providerId,
      plan: 'medical_director',
      status: 'active',
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId,
      startDate: new Date(),
    })
  }
}
