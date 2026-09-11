'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { medicalDirectorCredentials, memberships, providers } from '@/lib/db/schema'
import { notifyMedicalDirectorSubmitted } from '@/lib/notify-melanite'
import { isOnboarding } from '@/lib/onboarding'
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
  url?: string
  error?: string
}

// Subscription actions. Both create a Stripe-hosted session and hand the provider off, so no
// card details ever reach this app — that keeps it out of PCI scope entirely, and is what v1
// does too.
//
// Neither of these grants access. Paying does not set medical_director_status; the
// invoice.payment_succeeded webhook does. That split is deliberate: a checkout that completes
// but whose payment later fails must not have already opened the booking gate.


/** Opens a subscription checkout, recovering from a stale billing customer.
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
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  const base = await appOrigin()

  // A provider still in setup returns to the medical-director step, not to Membership. Their
  // remaining steps are there, and Membership shows nothing they can act on yet.
  const back = isOnboarding(user) ? '/onboarding/director' : '/app/membership'

  try {
    const session = await stripePost<{ url?: string }>(
      '/checkout/sessions',
      {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${base}${back}?subscribed=1`,
        cancel_url: `${base}${back}`,
        // The webhook has no other way to know whose subscription this is. Set on BOTH the
        // session and the subscription, because checkout.session.completed and
        // invoice.payment_succeeded read from different objects.
        // `plan` is what the webhooks route on. Without it every subscription looks like the
        // director plan, which is the default — correct for anything created before Epicutis
        // existed, and wrong for anything created after.
        metadata: { provider_id: user.id, plan: 'medical_director' },
        subscription_data: {
          metadata: { provider_id: user.id, plan: 'medical_director' },
        },
        ...(provider?.stripeBillingCustomerId
          ? { customer: provider.stripeBillingCustomerId }
          : { customer_email: provider?.email }),
      },
      {
        // Keyed on the provider, so a double-click or a retried request reuses the same
        // session rather than starting a second subscription. Stripe replays the original
        // response for 24 hours, which is far longer than anyone spends deciding.
        idempotencyKey: `md-subscribe:${user.id}`,
      },
    )

    return session.url ? { url: session.url } : { error: 'Stripe did not return a checkout link.' }
  } catch (err) {
    return { error: friendlyStripeError(err, 'Could not start checkout. Try again shortly.') }
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
