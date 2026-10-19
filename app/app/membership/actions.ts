'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { medicalDirectorCredentials, memberships, providers } from '@/lib/db/schema'
import { notifyMedicalDirectorSubmitted } from '@/lib/notify-melanite'
import { friendlyStripeError, stripePost } from '@/lib/stripe/client'
import {
  appOrigin,
  epicutisPriceId,
  isMissingCustomerError,
  medicalDirectorPriceId,
  modeMismatch,
} from '@/lib/stripe/config'
import { DATE_ONLY, emailError, futureDateError, isValidPhone, nameError } from '@/lib/validation'

export interface StripeRedirect {
  /** Set when the provider still has to go somewhere — the billing portal, and the Epicutis
   *  checkout. The director plan no longer returns one: it bills the card on file. */
  url?: string
  /** Set when the thing happened here and there is nowhere to send them. */
  success?: string
  error?: string
}

// Subscription actions.
//
// NO CARD DETAILS EVER REACH THIS APP, which keeps it out of PCI scope entirely, and that is
// still true after the director plan stopped using a hosted checkout. It bills
// `providers.billingPaymentMethodId` — a Stripe payment method id, saved by Stripe's own
// element during onboarding. An id is not a card number; the only thing this code can do with
// one is ask Stripe to charge it.
//
// Epicutis still hands off to Checkout. It is bought by people who may have no card on file
// yet, whereas the director plan is part of onboarding and the card is already there.
//
// Neither of these grants access. Paying does not set medical_director_status; the
// invoice.payment_succeeded webhook does. That split is deliberate: a checkout that completes
// but whose payment later fails must not have already opened the booking gate.


/** Starts the medical director plan on the provider's card on file.
 *
 *  Reusing the stored customer is what keeps both subscriptions on one Stripe record so the
 *  billing portal can manage them together. But a stored id that Stripe no longer recognises
 *  turns the button into a dead end — nothing in the app can edit it — so a "no such customer"
 *  failure clears it and retries as a fresh customer. The webhook writes the new id back.
 */
async function subscriptionCheckout(
  providerId: string,
  email: string | undefined,
  storedCustomerId: string | null | undefined,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<StripeRedirect> {
  const open = async (customer: string | null, key: string) =>
    stripePost<{ url?: string }>(
      '/checkout/sessions',
      { ...payload, ...(customer ? { customer } : { customer_email: email }) },
      { idempotencyKey: key },
    )

  try {
    const session = await open(storedCustomerId ?? null, idempotencyKey)
    return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
  } catch (err) {
    if (!storedCustomerId || !isMissingCustomerError(err)) {
      return { error: friendlyStripeError(err, 'Could not start the subscription.') }
    }

    console.warn(`[stripe] clearing unknown billing customer ${storedCustomerId} for ${providerId}`)
    await db
      .update(providers)
      .set({ stripeBillingCustomerId: null })
      .where(eq(providers.id, providerId))

    try {
      // A different key: the first attempt is cached against the old customer, and replaying it
      // would hand back the same failure.
      const session = await open(null, `${idempotencyKey}:recustomer`)
      return session.url
        ? { url: session.url }
        : { error: 'Stripe did not return a checkout link.' }
    } catch (retryErr) {
      return { error: friendlyStripeError(retryErr, 'Could not start the subscription.') }
    }
  }
}

export async function startSubscription(): Promise<StripeRedirect> {
  const user = await requireProvider()

  if (user.medicalDirectorStatus === 'active' || user.medicalDirectorStatus === 'past_due') {
    return { error: 'You already have a medical director subscription.' }
  }

  const priceId = await medicalDirectorPriceId()
  if (!priceId) {
    return { error: 'The medical director plan isn’t configured yet. Contact Melanite.' }
  }

  // A test key with a live price (or the reverse) fails at Stripe with an opaque "No such
  // price", which is a poor place to discover a config mistake. Say it here instead.
  const mismatch = modeMismatch(priceId)
  if (mismatch) console.warn(`[membership] ${mismatch}`)

  const [provider] = await db
    .select({
      email: providers.email,
      stripeBillingCustomerId: providers.stripeBillingCustomerId,
      billingPaymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  // THE CARD ON FILE, created directly rather than through a checkout redirect.
  //
  // Checkout in subscription mode always collects a card, so a provider who had already given
  // one ended up with two on record — and the monthly bill followed whichever they typed
  // second. One card per provider is what makes "their card was declined" a sentence Keoni can
  // act on rather than a question about which card.
  //
  // NEVER CONNECT. This is a provider paying Melanite; Connect pays providers out and has no
  // part in it. It never did here, and saying so stops anybody adding `transfer_data` on the
  // assumption that every Stripe call in this codebase wants it.
  if (!provider?.stripeBillingCustomerId || !provider?.billingPaymentMethodId) {
    return {
      error: 'Add a card on your account page first — the plan bills to the card you keep there.',
    }
  }

  try {
    await stripePost<{ id: string; status: string }>(
      '/subscriptions',
      {
        customer: provider.stripeBillingCustomerId,
        items: [{ price: priceId }],
        // The card this bills every month, now and at renewal.
        default_payment_method: provider.billingPaymentMethodId,
        // Nobody is at a checkout to answer a 3DS challenge. A card that insists on one fails
        // the first invoice, which `handleInvoicePaymentFailed` already reports.
        off_session: true,
        // `plan` is what the webhooks route on. Without it every subscription looks like the
        // director plan, which is the default — right for anything created before Epicutis
        // existed and wrong for anything created after.
        metadata: { provider_id: user.id, plan: 'medical_director' },
      },
      {
        // Keyed on the provider, so a double-click cannot start two subscriptions. Stripe
        // replays the original response for 24 hours, far longer than anyone spends deciding.
        idempotencyKey: `md-subscribe:${user.id}`,
      },
    )

    // The membership row and the booking gate are written by `handleSubscriptionChanged` from
    // the webhook, exactly as before. Only how the subscription is created has changed.
    return { success: 'Subscribed. The plan bills monthly to the card on your account.' }
  } catch (err) {
    return {
      error: friendlyStripeError(
        err,
        'Could not start the plan. Check the card on your account page and try again.',
      ),
    }
  }
}

export async function openBillingPortal(): Promise<StripeRedirect> {
  const user = await requireProvider()

  const [provider] = await db
    .select({ stripeBillingCustomerId: providers.stripeBillingCustomerId })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!provider?.stripeBillingCustomerId) {
    return { error: 'No billing account on file yet.' }
  }

  const base = await appOrigin()

  try {
    // No idempotency key: a portal session moves no money and expires quickly, so reusing a
    // stale one for 24 hours would be worse than making a fresh one each time.
    const session = await stripePost<{ url?: string }>('/billing_portal/sessions', {
      customer: provider.stripeBillingCustomerId,
      return_url: `${base}/app/membership`,
    })

    return session.url ? { url: session.url } : { error: 'Stripe did not return a portal link.' }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not open the billing portal. Try again shortly.') }
  }
}

/**
 * The Epicutis membership — $95/month for monthly content, client inquiries and wholesale
 * pricing.
 *
 * Unlocks NOTHING in this app, and that is the important part. It sits beside the medical
 * director plan on the same page and is charged the same way, so the temptation is to treat
 * them as two of a kind; they are not. One is a booking gate and the other is a benefit
 * delivered entirely outside this system. The webhooks tell them apart by the `plan` metadata
 * set below — before that existed, paying for this would have granted medical direction and
 * cancelling it would have revoked the ability to book.
 */
export async function startEpicutisSubscription(): Promise<StripeRedirect> {
  const user = await requireProvider()

  // Any active provider may subscribe, including someone still waiting on document approval:
  // content and wholesale access has nothing to do with whether they can operate the laser yet.
  const [existing] = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.providerId, user.id), eq(memberships.plan, 'epicutis')))
    .limit(1)

  if (existing && (existing.status === 'active' || existing.status === 'past_due')) {
    return { error: 'You already have an Epicutis membership.' }
  }

  const priceId = await epicutisPriceId()
  if (!priceId) {
    return { error: 'The Epicutis membership isn’t configured yet. Contact Melanite.' }
  }

  const mismatch = modeMismatch(priceId)
  if (mismatch) console.warn(`[epicutis] ${mismatch}`)

  const [provider] = await db
    .select({
      email: providers.email,
      stripeBillingCustomerId: providers.stripeBillingCustomerId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await appOrigin()

  // Reuses the billing customer the director plan created, so both subscriptions sit on one
  // Stripe record and the billing portal manages them together.
  return subscriptionCheckout(
    user.id,
    provider?.email,
    provider?.stripeBillingCustomerId,
    {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/app/membership?epicutis=1`,
      cancel_url: `${base}/app/membership`,
      metadata: { provider_id: user.id, plan: 'epicutis' },
      subscription_data: { metadata: { provider_id: user.id, plan: 'epicutis' } },
    },
    `epicutis-subscribe:${user.id}`,
  )
}

export interface DirectorState {
  error?: string
  success?: string
}

/**
 * A provider records her own medical director.
 *
 * THIS DID NOT EXIST, and the gap was invisible because nobody had used the path. Every provider
 * until now took the Melanite plan, where Stripe drives the gate and the page has a real button.
 * The own-director path could DISPLAY an arrangement and never create one: no form, no action, no
 * admin screen, and `medical_director_credentials` empty in production. Meanwhile the booking gate
 * told her "You need a medical director on file before booking" and linked her here — a
 * call-to-action pointing at a page where the thing could not be done.
 *
 * IT DOES NOT OPEN THE GATE. Saving details is the provider stating who supervises her; deciding
 * that the arrangement is real is Melanite's, and it is a clinical judgement about a person's
 * licence, not a form validation. `medicalDirectorStatus` therefore stays where it is and Melanite
 * is told there is something to review. A provider who could activate her own clinical gate by
 * typing a name into a box would make the gate decorative.
 *
 * Editing while ACTIVE does not close the gate either. Dropping a working provider back to blocked
 * because she corrected a phone number would be a surprise lockout mid-clinic — Melanite is told
 * instead, and can act.
 */
export async function saveMedicalDirector(
  _prev: DirectorState,
  formData: FormData,
): Promise<DirectorState> {
  const user = await requireProvider()

  const [provider] = await db
    .select({
      type: providers.medicalDirectorType,
      status: providers.medicalDirectorStatus,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  // Only the own-director path. On the Melanite plan the director is Melanite's, and letting a
  // provider type a different name over it would leave the record disagreeing with who is
  // actually supervising her.
  if (provider?.type !== 'own') {
    return { error: 'Your directorship is provided by Melanite, so there is nothing to enter.' }
  }

  const name = String(formData.get('name') ?? '').trim()
  const credentials = String(formData.get('credentials') ?? '').trim() || null
  const npi = String(formData.get('npi') ?? '').trim() || null
  const licenseNumber = String(formData.get('licenseNumber') ?? '').trim() || null
  const licenseState = String(formData.get('licenseState') ?? '').trim() || null
  const licenseExpiryRaw = String(formData.get('licenseExpiry') ?? '').trim()
  const contactEmail = String(formData.get('contactEmail') ?? '').trim() || null
  const contactPhone = String(formData.get('contactPhone') ?? '').trim() || null

  const nameProblem = nameError(name, 'Your medical director’s name')
  if (nameProblem) return { error: nameProblem }

  // NPI is ten digits. Checked because a wrong one is worse than a blank one: it looks like a
  // verified fact and sends whoever checks it to a different clinician entirely.
  if (npi && !/^\d{10}$/.test(npi)) {
    return { error: 'An NPI is ten digits. Leave it blank if you don’t have it to hand.' }
  }

  if (contactEmail) {
    const emailProblem = emailError(contactEmail)
    if (emailProblem) return { error: emailProblem }
  }

  if (contactPhone && !isValidPhone(contactPhone)) {
    return { error: 'That phone number doesn’t look right — 10 digits, or leave it blank.' }
  }

  if (licenseExpiryRaw) {
    if (!DATE_ONLY.test(licenseExpiryRaw)) {
      return { error: 'The license expiry must be a valid date.' }
    }
    // Same rule the provider's own licence gets on the account page. A director whose licence
    // has lapsed is not supervising anybody, and saving it quietly would hide that.
    const expired = futureDateError(licenseExpiryRaw, { label: 'a license expiry date' })
    if (expired) {
      return {
        error:
          expired === 'That date has already passed.'
            ? 'That license has already expired. Melanite cannot accept a lapsed director.'
            : expired,
      }
    }
  }

  const existing = await db
    .select({ providerId: medicalDirectorCredentials.providerId })
    .from(medicalDirectorCredentials)
    .where(eq(medicalDirectorCredentials.providerId, user.id))
    .limit(1)

  const values = {
    name,
    credentials,
    npi,
    licenseNumber,
    licenseState,
    licenseExpiry: licenseExpiryRaw || null,
    contactEmail,
    contactPhone,
  }

  if (existing.length > 0) {
    await db
      .update(medicalDirectorCredentials)
      .set(values)
      .where(eq(medicalDirectorCredentials.providerId, user.id))
  } else {
    await db.insert(medicalDirectorCredentials).values({ providerId: user.id, ...values })
  }

  // Best effort, after the record exists — the same contract every other notification here has.
  // A provider who has done her part must never be told it failed because an email did not send.
  await notifyMedicalDirectorSubmitted(user.id, { changed: existing.length > 0 })

  revalidatePath('/app/membership')
  revalidatePath('/app/admin/providers')

  return {
    success:
      provider.status === 'active'
        ? 'Saved. Melanite has been told your director details changed.'
        : 'Saved. Melanite will review this and open booking once it is confirmed.',
  }
}
