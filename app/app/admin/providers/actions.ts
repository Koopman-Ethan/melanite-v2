'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

export interface ToggleState {
  error?: string
  success?: string
}

/**
 * Grants or revokes a provider's access to booking and to the rental room.
 *
 * `requireAdmin()`, which admits platform_owner and developer only. The medical director is
 * deliberately NOT admitted: clinical oversight is not the same authority as deciding who may
 * take clients, and these toggles sit alongside the money surfaces.
 *
 * Only these two fields are writable here. A general provider editor would be easier to build
 * and much worse to own — it is how a license date or a Stripe account id gets overwritten by
 * a stale form.
 */
export async function setProviderAccess(input: {
  providerId: string
  field: 'bookingEnabled' | 'roomRentalEnabled'
  value: boolean
}): Promise<ToggleState> {
  const admin = await requireAdmin()

  if (input.field !== 'bookingEnabled' && input.field !== 'roomRentalEnabled') {
    return { error: 'That is not a field you can change here.' }
  }

  const [target] = await db
    .select({
      id: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      status: providers.status,
      role: providers.role,
    })
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1)

  if (!target) return { error: 'That provider does not exist.' }

  if (target.status === 'inactive') {
    return { error: 'That account is inactive. Reactivate it before granting access.' }
  }

  // Granting booking to someone still in setup would let them take a client before they have a
  // license on file — step 3 has not happened yet.
  if (input.field === 'bookingEnabled' && input.value && target.status === 'pending') {
    return { error: 'They haven’t finished setting up yet. Booking can’t be enabled until they have.' }
  }

  // Self-revocation is allowed; self-grant is the one that should give pause. Neither is
  // blocked outright — Keoni is a provider as well as the owner — but removing your own access
  // by mis-clicking a row is worth a word.
  const isSelf = target.id === admin.id

  await db
    .update(providers)
    .set({ [input.field]: input.value })
    .where(eq(providers.id, input.providerId))

  revalidatePath('/app/admin/providers')

  const what = input.field === 'bookingEnabled' ? 'Booking' : 'Room rental'
  const who = isSelf ? 'you' : `${target.firstName} ${target.lastName}`

  return {
    success: `${what} ${input.value ? 'enabled' : 'disabled'} for ${who}.`,
  }
}

/**
 * Moves a provider between renting the room and using the laser.
 *
 * People change what they do, and this must not require a database edit. The two directions are
 * not symmetrical, though, and pretending otherwise is where this would go wrong:
 *
 * Going to `laser` opens two steps that were never asked — a Connect account, so Melanite can
 * pay them their share, and a service menu, so there is something to book. Neither can be
 * conjured by an admin, so the account is returned to setup at step 3 and the provider walks
 * them itself on next sign-in. Flipping the column alone would leave somebody marked as a laser
 * provider with no way to be paid, which surfaces as a failed payout weeks later.
 *
 * Going to `room_only` takes nothing away that matters: an unused Connect account and a service
 * list nobody can book are harmless, and they are worth keeping in case the person moves back.
 * But booking is revoked, because "room only" and "may use the laser" cannot both be true.
 *
 * What this does NOT do is edit their declaration of what they perform. That is the provider's
 * own statement with a date on it, and its whole value is that Melanite did not write it.
 */
export async function setPracticeType(input: {
  providerId: string
  practiceType: 'laser' | 'room_only'
}): Promise<ToggleState> {
  await requireAdmin()

  if (input.practiceType !== 'laser' && input.practiceType !== 'room_only') {
    return { error: 'That is not a practice type.' }
  }

  const [target] = await db
    .select({
      id: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      status: providers.status,
      practiceType: providers.practiceType,
      stripeOnboardingComplete: providers.stripeOnboardingComplete,
    })
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1)

  if (!target) return { error: 'That provider does not exist.' }
  if (target.practiceType === input.practiceType) return { success: 'No change.' }

  const who = `${target.firstName} ${target.lastName}`

  if (input.practiceType === 'room_only') {
    await db
      .update(providers)
      .set({ practiceType: 'room_only', bookingEnabled: false })
      .where(eq(providers.id, input.providerId))

    revalidatePath('/app/admin/providers')
    return { success: `${who} now rents the room only. Laser booking has been turned off.` }
  }

  // Somebody already through Stripe has nothing left to walk, so do not send them back through
  // setup for the sake of it — the services step alone is not worth locking an account for.
  const needsSetup = !target.stripeOnboardingComplete

  await db
    .update(providers)
    .set(
      needsSetup
        ? { practiceType: 'laser', status: 'pending', onboardingStep: 3 }
        : { practiceType: 'laser' },
    )
    .where(eq(providers.id, input.providerId))

  revalidatePath('/app/admin/providers')

  return {
    success: needsSetup
      ? `${who} moved to laser. They'll be asked to connect Stripe and pick services next time they sign in.`
      : `${who} moved to laser.`,
  }
}
