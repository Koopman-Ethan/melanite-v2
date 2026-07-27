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
 * and much worse to own — it is how a licence date or a Stripe account id gets overwritten by
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
  // licence on file — step 3 has not happened yet.
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
