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

  if (!firstName || !lastName) return { error: 'Enter your first and last name.' }
  if (!phone) return { error: 'Enter a phone number — bookings and client messages use it.' }

  await completeStep(user.id, 2, {
    firstName,
    lastName,
    phone,
    credentials: input.credentials.trim() || null,
  })

  redirect('/onboarding/license')
}

/** Step 3 — licence and insurance.
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

  if (!licenseNumber) return { error: 'Enter your licence number.' }
  if (!licenseState) return { error: 'Enter the state your licence was issued in.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.licenseExpiry)) {
    return { error: 'Enter the licence expiry date.' }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  if (input.licenseExpiry < today) {
    // Refused rather than accepted-and-flagged: an expired licence blocks booking anyway, and
    // storing it silently would leave someone stuck at the last gate with no idea why.
    return { error: 'That licence has already expired. Renew it before setting up your account.' }
  }

  await completeStep(user.id, 3, {
    licenseNumber,
    licenseState,
    licenseExpiry: input.licenseExpiry,
    malpracticeInsurance: input.malpracticeInsurance.trim() || null,
  })

  redirect('/onboarding/stripe')
}

/** Step 4 — acknowledges that Stripe onboarding has been started or finished.
 *
 *  Whether payouts actually work is decided by `stripeOnboardingComplete`, which only the
 *  `account.updated` webhook sets. This just records that the provider has been through the
 *  hand-off, so they are not blocked from continuing while Stripe verifies them. */
export async function completeStripeStep(): Promise<StepState> {
  const user = await requireProvider()
  await completeStep(user.id, 4, {})
  redirect('/onboarding/director')
}

/** Step 5 — medical director.
 *
 *  Either path is recorded here; NEITHER opens the booking gate. The Melanite path needs a paid
 *  subscription (the invoice webhook sets `medicalDirectorStatus`), and the own-director path
 *  needs a signed supervision agreement that Keoni confirms by hand. v1 said the same thing on
 *  this screen: "an active subscription alone doesn't unlock booking".
 */
export async function saveDirectorChoice(choice: 'melanite' | 'own'): Promise<StepState> {
  const user = await requireProvider()

  if (choice !== 'melanite' && choice !== 'own') return { error: 'Choose an option to continue.' }

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
