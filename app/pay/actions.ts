'use server'

import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getBookingCheckout, getPackageCheckout } from '@/lib/db/queries/checkout'
import {
  bookings,
  checkoutLinks,
  clients,
  packageCheckoutLinks,
  platformSettings,
  providers,
} from '@/lib/db/schema'
import { splitClientPayment, toCents, toMoney } from '@/lib/money'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'

// PUBLIC actions — reachable by anyone holding a link token. No session, no provider identity.
//
// Everything that decides money is read from the database here, never taken from the caller.
// The client supplies a tip, an email and a consent flag; the price, the provider, the split
// and the destination account all come from rows the caller cannot influence.

export interface IntentState {
  clientSecret?: string
  amount?: number
  error?: string
}

/** The payment methods Melanite accepts, stated explicitly.
 *
 *  NOT `automatic_payment_methods` — that hands the choice to Stripe, which surfaces whatever
 *  it thinks converts (Klarna, Afterpay, Cash App) and cannot be reliably suppressed from the
 *  Dashboard, since those toggles are per-mode and interact with automatic methods in ways that
 *  look like they have not taken effect. An explicit list is deterministic: what is here is
 *  what a client sees.
 *
 *  Buy-now-pay-later is deliberately absent. Melanite's financing partner is Cherry, and a
 *  competing BNPL button beside it splits the one route the business actually has a
 *  relationship with. v1 used this same explicit pair.
 *
 *  Card covers Apple Pay and Google Pay — those ride on the card rail, not separate types. */
const PAYMENT_METHODS = ['card', 'link'] as const


/** Creates (or re-creates) the PaymentIntent for a booking link.
 *
 *  A DESTINATION CHARGE on the platform account: the client pays Melanite, Stripe forwards the
 *  provider's share to their connected account, and Melanite keeps `application_fee_amount`.
 *  Tips are excluded from the fee base — 100% of a tip reaches the provider, which is v1's rule
 *  and the one providers were told.
 *
 *  Re-calling replaces the intent rather than editing it, matching v1: the client may change
 *  the tip, and an abandoned unconfirmed intent costs nothing and expires on its own.
 */
export async function createBookingIntent(input: {
  token: string
  tipAmount: number
  clientEmail: string | null
  saveCard: boolean
}): Promise<IntentState> {
  const checkout = await getBookingCheckout(input.token)
  if (!checkout) return { error: 'That payment link does not exist.' }
  if (checkout.state !== 'payable') {
    return { error: notPayableMessage(checkout.state) }
  }

  const tip = Number.isFinite(input.tipAmount) ? Math.max(input.tipAmount, 0) : 0
  if (tip > 10_000) return { error: 'That tip is not a valid amount.' }

  const [booking] = await db
    .select({
      id: bookings.id,
      providerId: bookings.providerId,
      clientId: bookings.clientId,
      clientName: bookings.clientName,
      clientPhone: bookings.clientPhone,
      price: bookings.price,
    })
    .from(bookings)
    .where(eq(bookings.id, checkout.bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment no longer exists.' }

  const [provider] = await db
    .select({ stripeAccountId: providers.stripeAccountId })
    .from(providers)
    .where(eq(providers.id, booking.providerId))
    .limit(1)

  if (!provider?.stripeAccountId) {
    return { error: 'This provider cannot accept payments yet. Contact them directly.' }
  }

  const settings = await getSplitSettings()
  const priceCents = toCents(booking.price)
  const tipCents = toCents(tip)
  // The SAME function the webhook uses to write the ledger row, so what Stripe takes and what
  // the books record cannot drift apart.
  const { melaniteCutCents: feeCents } = splitClientPayment({
    grossCents: priceCents,
    tipCents,
    providerSharePct: settings.providerSharePct,
  })

  try {
    const clientId = await ensureClientRow({
      clientId: booking.clientId,
      bookingId: booking.id,
      name: booking.clientName,
      email: input.clientEmail,
      phone: booking.clientPhone,
    })

    const customerId = await ensureStripeCustomer(clientId, booking.clientName, input.clientEmail)

    const intent = await stripePost<{ id: string; client_secret: string }>('/payment_intents', {
      amount: priceCents + tipCents,
      currency: 'usd',
      customer: customerId,
      payment_method_types: PAYMENT_METHODS,
      // The page asks for this address under the words "Email for your receipt", and until now
      // nothing sent one. Stripe's own receipt is better than anything written here: it carries
      // the card's last four and a permanent hosted URL, and a refund later produces a matching
      // refund receipt with no work at all. Training already did this; bookings never did.
      receipt_email: input.clientEmail,
      transfer_data: { destination: provider.stripeAccountId },
      application_fee_amount: feeCents,
      // Saving the card is what makes a no-show fee collectable at all. It is the client's
      // choice, and declining must not block the payment.
      ...(input.saveCard ? { setup_future_usage: 'off_session' } : {}),
      metadata: {
        type: 'booking_payment',
        booking_id: booking.id,
        checkout_link_id: checkout.linkId,
        client_id: clientId,
        tip_amount: toMoney(toCents(tip)),
        save_card: input.saveCard ? '1' : '0',
        card_policy_version: settings.cardPolicyVersion,
      },
    })

    await db
      .update(checkoutLinks)
      .set({
        tipAmount: toMoney(toCents(tip)),
        stripeCustomerId: customerId,
        stripePaymentIntentId: intent.id,
      })
      .where(eq(checkoutLinks.id, checkout.linkId))

    if (input.clientEmail) {
      await db
        .update(bookings)
        .set({ clientEmail: input.clientEmail })
        .where(eq(bookings.id, booking.id))
    }

    return { clientSecret: intent.client_secret, amount: (priceCents + tipCents) / 100 }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not start the payment. Try again shortly.') }
  }
}

/** Creates the PaymentIntent for a package link. Same destination-charge shape as a booking. */
export async function createPackageIntent(input: {
  token: string
  tipAmount: number
  clientName: string | null
  clientEmail: string | null
  saveCard: boolean
}): Promise<IntentState> {
  const checkout = await getPackageCheckout(input.token)
  if (!checkout) return { error: 'That payment link does not exist.' }
  if (checkout.state !== 'payable') return { error: notPayableMessage(checkout.state) }

  const tip = Number.isFinite(input.tipAmount) ? Math.max(input.tipAmount, 0) : 0

  const [link] = await db
    .select({
      id: packageCheckoutLinks.id,
      providerId: packageCheckoutLinks.providerId,
      clientId: packageCheckoutLinks.clientId,
      templateId: packageCheckoutLinks.packageTemplateId,
    })
    .from(packageCheckoutLinks)
    .where(eq(packageCheckoutLinks.id, checkout.linkId))
    .limit(1)

  if (!link) return { error: 'That payment link does not exist.' }

  const [provider] = await db
    .select({ stripeAccountId: providers.stripeAccountId })
    .from(providers)
    .where(eq(providers.id, link.providerId))
    .limit(1)

  if (!provider?.stripeAccountId) {
    return { error: 'This provider cannot accept payments yet. Contact them directly.' }
  }

  const name = input.clientName?.trim() || checkout.clientName
  const email = input.clientEmail?.trim() || checkout.clientEmail
  // A package creates a durable balance owned by a client row, so unlike a booking there is no
  // walk-in path — without an identity there is nothing to attach the sessions to.
  if (!email) return { error: 'Enter an email so your package can be tracked.' }

  const settings = await getSplitSettings()
  const priceCents = toCents(checkout.price)
  const tipCents = toCents(tip)
  const { melaniteCutCents: feeCents } = splitClientPayment({
    grossCents: priceCents,
    tipCents,
    providerSharePct: settings.providerSharePct,
  })

  try {
    const clientId = await ensureClientRow({
      clientId: link.clientId,
      name: name ?? null,
      email,
      phone: null,
    })

    const customerId = await ensureStripeCustomer(clientId, name, email)

    const intent = await stripePost<{ id: string; client_secret: string }>('/payment_intents', {
      amount: priceCents + tipCents,
      currency: 'usd',
      customer: customerId,
      payment_method_types: PAYMENT_METHODS,
      receipt_email: email,
      transfer_data: { destination: provider.stripeAccountId },
      application_fee_amount: feeCents,
      ...(input.saveCard ? { setup_future_usage: 'off_session' } : {}),
      metadata: {
        type: 'package_purchase',
        package_template_id: link.templateId,
        package_checkout_link_id: link.id,
        provider_id: link.providerId,
        client_id: clientId,
        tip_amount: toMoney(toCents(tip)),
        save_card: input.saveCard ? '1' : '0',
        card_policy_version: settings.cardPolicyVersion,
      },
    })

    await db
      .update(packageCheckoutLinks)
      .set({
        tipAmount: toMoney(toCents(tip)),
        clientId,
        clientName: name,
        clientEmail: email,
        stripeCustomerId: customerId,
        stripePaymentIntentId: intent.id,
      })
      .where(eq(packageCheckoutLinks.id, link.id))

    return { clientSecret: intent.client_secret, amount: (priceCents + tipCents) / 100 }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not start the payment. Try again shortly.') }
  }
}

// ---------------------------------------------------------------------------

async function getSplitSettings() {
  const [row] = await db
    .select({
      providerSharePct: platformSettings.providerSharePct,
      cardPolicyVersion: platformSettings.cardPolicyVersion,
    })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return {
    providerSharePct: Number(row?.providerSharePct ?? 0.5),
    cardPolicyVersion: row?.cardPolicyVersion ?? '2026-07-27.v1',
  }
}

/** Resolves the durable client identity, creating one if the booking was taken for a walk-in.
 *
 *  A client row must exist before payment because the saved card hangs off it — without one
 *  there is a card in Stripe belonging to nobody this system can name. */
async function ensureClientRow(input: {
  clientId?: string | null
  bookingId?: string
  name: string | null
  email: string | null
  phone: string | null
}): Promise<string> {
  if (input.clientId) return input.clientId

  const email = input.email?.trim().toLowerCase() || null

  if (email) {
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.email, email))
      .limit(1)

    if (existing) {
      if (input.bookingId) {
        await db
          .update(bookings)
          .set({ clientId: existing.id })
          .where(eq(bookings.id, input.bookingId))
      }
      return existing.id
    }
  }

  const [created] = await db
    .insert(clients)
    .values({ email, name: input.name, phone: input.phone })
    .returning({ id: clients.id })

  if (input.bookingId) {
    await db.update(bookings).set({ clientId: created.id }).where(eq(bookings.id, input.bookingId))
  }

  return created.id
}

/** The Stripe Customer lives on the PLATFORM account, not the provider's connected account.
 *
 *  That is deliberate and load-bearing: Melanite charges the no-show fee and splits it, so the
 *  saved card has to belong to Melanite's account. A card saved on the connected account would
 *  be unusable for exactly the thing it was collected for. */
async function ensureStripeCustomer(
  clientId: string,
  name: string | null,
  email: string | null,
): Promise<string> {
  const [row] = await db
    .select({ stripeCustomerId: clients.stripeCustomerId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1)

  if (row?.stripeCustomerId) return row.stripeCustomerId

  const customer = await stripePost<{ id: string }>(
    '/customers',
    {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      metadata: { client_id: clientId },
    },
    { idempotencyKey: `client-customer:${clientId}` },
  )

  await db
    .update(clients)
    .set({ stripeCustomerId: customer.id })
    .where(eq(clients.id, clientId))

  return customer.id
}

function notPayableMessage(state: string): string {
  switch (state) {
    case 'paid':
      return 'This has already been paid.'
    case 'expired':
      return 'This payment link has expired. Ask your provider for a new one.'
    case 'cancelled':
      return 'This payment link was cancelled.'
    default:
      return 'This is no longer payable. Contact your provider.'
  }
}

/**
 * Records that a client left for Cherry.
 *
 * Cherry is a hand-off, not an integration: the client finishes on Cherry's site and the money
 * reaches Keoni directly, so no webhook ever comes back here. Without this the link sits at
 * `pending` indefinitely and is indistinguishable from one nobody opened — while the page
 * itself tells the client to "tell your provider", a workflow held together by somebody
 * remembering to pass a message on.
 *
 * This records INTENT, never payment. It says they went, not that they paid, and the wording
 * everywhere downstream says the same — a package marked paid because somebody clicked a link
 * would be worse than no signal at all.
 *
 * Deliberately forgiving: the client is mid-checkout on a four-figure purchase, and a failure
 * to write a tracking timestamp must never stand between them and Cherry.
 */
export async function noteCherryHandoff(token: string): Promise<void> {
  try {
    await db
      .update(packageCheckoutLinks)
      .set({ cherryStartedAt: new Date() })
      .where(
        and(
          eq(packageCheckoutLinks.token, token),
          eq(packageCheckoutLinks.status, 'pending'),
          isNull(packageCheckoutLinks.cherryStartedAt),
        ),
      )
  } catch (err) {
    console.error('[cherry] could not record hand-off for', token, err)
  }
}
