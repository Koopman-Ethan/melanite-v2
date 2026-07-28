'use server'

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providerServices, providers } from '@/lib/db/schema'
import { toCents, toMoney } from '@/lib/money'
import { nextStepSlug } from '@/lib/onboarding'

export interface StepState {
  error?: string
}

/** Advances progress without ever moving it backwards.
 *
 *  A provider revisiting step 2 to fix a typo must not be sent back to the start of the flow,
 *  so this takes the greater of what they had and what they just completed. */
async function completeStep(providerId: string, step: number, patch: Record<string, unknown>) {
  const [row] = await db
    .select({ step: providers.onboardingStep })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  await db
    .update(providers)
    .set({ ...patch, onboardingStep: Math.max(row?.step ?? 1, step) })
    .where(eq(providers.id, providerId))
}

/** Step 2 — the name and credentials a client sees on a checkout page. */
export async function saveProfile(input: {
  firstName: string
  lastName: string
  phone: string
  credentials: string
}): Promise<StepState> {
  const user = await requireProvider()

  const firstName = input.firstName.trim()
  const lastName = input.lastName.trim()
  const phone = input.phone.trim()

  const credentials = input.credentials.trim()

  if (!firstName || !lastName) return { error: 'Enter your first and last name.' }
  if (!phone) return { error: 'Enter a phone number — bookings and client messages use it.' }
  if (!credentials) {
    return { error: 'Enter your professional credentials — clients see them at checkout.' }
  }

  await completeStep(user.id, 2, { firstName, lastName, phone, credentials })

  redirect('/onboarding/license')
}

/** Step 3 — license and insurance.
 *
 *  Documents themselves are emailed to Melanite rather than uploaded, matching v1. The
 *  `documents` table and an upload path exist; wiring them is deliberately deferred rather than
 *  half-built, and the form says plainly what has to be emailed instead. */
export async function saveLicense(input: {
  licenseNumber: string
  licenseState: string
  licenseExpiry: string
  malpracticeInsurance: string
}): Promise<StepState> {
  const user = await requireProvider()

  const licenseNumber = input.licenseNumber.trim()
  const licenseState = input.licenseState.trim()
  const malpracticeInsurance = input.malpracticeInsurance.trim()

  if (!licenseNumber) return { error: 'Enter your license number.' }
  if (!licenseState) return { error: 'Enter the state your license was issued in.' }
  if (!malpracticeInsurance) {
    return { error: 'Enter your malpractice insurance provider.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.licenseExpiry)) {
    return { error: 'Enter the license expiry date.' }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  if (input.licenseExpiry < today) {
    // Refused rather than accepted-and-flagged: an expired license blocks booking anyway, and
    // storing it silently would leave someone stuck at the last gate with no idea why.
    return { error: 'That license has already expired. Renew it before setting up your account.' }
  }

  await completeStep(user.id, 3, {
    licenseNumber,
    licenseState,
    licenseExpiry: input.licenseExpiry,
    malpracticeInsurance,
  })

  redirect('/onboarding/stripe')
}

/** Step 4 — Stripe must be connected before anything else happens.
 *
 *  The gate is "an account exists", not "payouts are enabled". Those are different questions:
 *  the first is entirely within the provider's control and takes three minutes, the second is
 *  Stripe verifying them in the background and can take days. Blocking on the second would
 *  strand someone at step 4 with nothing they can do about it, so `stripeOnboardingComplete`
 *  — set only by the `account.updated` webhook — gates BOOKING instead, which is where it
 *  belongs.
 *
 *  Checked here rather than only in the form. The button that calls this is hidden until an
 *  account exists, but a hidden button is not a gate: a server action is a public endpoint.
 */
export async function completeStripeStep(): Promise<StepState> {
  const user = await requireProvider()

  const [row] = await db
    .select({ stripeAccountId: providers.stripeAccountId })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!row?.stripeAccountId) {
    return { error: 'Connect your bank account with Stripe before continuing.' }
  }

  await completeStep(user.id, 4, {})
  redirect('/onboarding/director')
}

/** Step 5 — medical director.
 *
 *  The two paths are gated differently, on purpose. Choosing Melanite's director means the
 *  subscription is paid HERE — it is a thing the provider can complete in the moment, and
 *  letting them past it would leave someone who is "set up" but has never paid, with nothing
 *  in the flow that ever asks again. Bringing their own director cannot be settled in the
 *  moment: it needs a signed supervision agreement that Keoni confirms by hand, so that path
 *  continues and the document requirement is stated instead.
 *
 *  NEITHER opens the booking gate. v1 said the same thing on this screen, and it is still the
 *  thing people get wrong: an active subscription alone doesn't unlock booking.
 */
export async function saveDirectorChoice(choice: 'melanite' | 'own'): Promise<StepState> {
  const user = await requireProvider()

  if (choice !== 'melanite' && choice !== 'own') return { error: 'Choose an option to continue.' }

  if (choice === 'melanite') {
    // Read fresh rather than trusting the session: the invoice webhook may well have landed in
    // the seconds since this page rendered, which is exactly the case that must not be refused.
    const [row] = await db
      .select({ status: providers.medicalDirectorStatus })
      .from(providers)
      .where(eq(providers.id, user.id))
      .limit(1)

    // `past_due` is deliberately not accepted. It means a payment has failed, and starting
    // someone off on a subscription that is already failing is how a provider ends up believing
    // they are covered when they are not.
    if (row?.status !== 'active') {
      return {
        error:
          'Your subscription isn’t active yet. Complete the payment, then try again — if you’ve just paid, give it a few seconds and press Check again.',
      }
    }
  }

  await completeStep(user.id, 5, { medicalDirectorType: choice })
  redirect('/onboarding/services')
}

/** Step 6 — the services offered, and the last step.
 *
 *  This is what makes the account ACTIVE. Not `bookingEnabled` though: Keoni still confirms
 *  insurance and medical-director documents before anyone takes a client, so finishing setup
 *  gets a provider into the app, not into the diary.
 */
export async function saveServices(
  selections: { serviceId: string; price: number; durationMins: number }[],
): Promise<StepState> {
  const user = await requireProvider()

  if (selections.length === 0) {
    return { error: 'Turn on at least one service — it is what clients book.' }
  }

  for (const selection of selections) {
    if (!(selection.price > 0)) return { error: 'Every service needs a price above zero.' }
    if (!Number.isInteger(selection.durationMins) || selection.durationMins <= 0) {
      return { error: 'Every service needs a duration.' }
    }
  }

  // Replaces rather than appends, so going back and changing the selection does not leave
  // services switched on that were deselected.
  await db.delete(providerServices).where(eq(providerServices.providerId, user.id))

  await db.insert(providerServices).values(
    selections.map((s) => ({
      providerId: user.id,
      serviceId: s.serviceId,
      price: toMoney(toCents(s.price)),
      durationMins: s.durationMins,
      isActive: true,
    })),
  )

  await completeStep(user.id, 6, { status: 'active' as const })

  redirect('/onboarding/done')
}

/** Sends a provider back a step without losing what they have entered. */
export async function goBack(currentStep: number): Promise<void> {
  await requireProvider()
  redirect(`/onboarding/${nextStepSlug(Math.max(currentStep - 2, 1))}`)
}
