'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { providerServices, services } from '@/lib/db/schema'

export interface ServiceActionState {
  error?: string
  success?: string
}

/** Price and duration validation, shared by update and add.
 *
 *  Duration bounds live on the master catalog, not on the provider's row — Melanite decides
 *  what is clinically sensible for a treatment, and a provider chooses within that. v1
 *  enforced this in both PATCH /provider-services and POST /me/services with the same
 *  DURATION_OUT_OF_RANGE code. */
function validate(
  price: number,
  durationMins: number,
  bounds: { minDurationMins: number; maxDurationMins: number },
): string | null {
  if (!Number.isFinite(price) || price <= 0) return 'Price must be greater than zero.'
  if (price > 100_000) return 'That price looks wrong — check the amount.'
  // Fractional cents round SILENTLY on the way into the ledger — money is integer cents
  // everywhere here — so a price typed as 200.005 becomes 200.01 without anybody being told.
  // Rejecting is the honest answer; rounding somebody's price for them is not.
  if (Math.round(price * 100) !== price * 100) return 'Use at most two decimal places.'
  if (!Number.isInteger(durationMins)) return 'Duration must be a whole number of minutes.'
  if (durationMins < bounds.minDurationMins) {
    return `Duration must be at least ${bounds.minDurationMins} minutes for this service.`
  }
  if (durationMins > bounds.maxDurationMins) {
    return `Duration cannot exceed ${bounds.maxDurationMins} minutes for this service.`
  }
  return null
}

export async function updateProviderService(
  providerServiceId: string,
  input: { price: number; durationMins: number; isActive: boolean },
): Promise<ServiceActionState> {
  const user = await requireProvider()

  // Ownership is part of the lookup, so there is no window where another provider's row is
  // read and rejected afterwards.
  const [row] = await db
    .select({
      id: providerServices.id,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      offeredPlatformWide: services.active,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(eq(providerServices.id, providerServiceId), eq(providerServices.providerId, user.id)),
    )
    .limit(1)

  if (!row) return { error: 'That service is not on your profile.' }

  const problem = validate(input.price, input.durationMins, row)
  if (problem) return { error: problem }

  // Turning something back on that Melanite has retired would produce a row that looks
  // bookable and is not — /book filters on both flags.
  if (input.isActive && !row.offeredPlatformWide) {
    return { error: 'Melanite has retired this service, so it can’t be switched back on.' }
  }

  await db
    .update(providerServices)
    .set({
      price: input.price.toFixed(2),
      durationMins: input.durationMins,
      isActive: input.isActive,
    })
    .where(eq(providerServices.id, providerServiceId))

  revalidatePath('/app/services')
  return { success: 'Saved.' }
}

/** Add a catalog service to the provider's profile.
 *
 *  New in v2. v1's POST /me/services is gated on onboarding_step == 4, so after onboarding a
 *  provider cannot add a service at all — it has to go through Melanite. */
export async function addProviderService(input: {
  serviceId: string
  price: number
  durationMins: number
}): Promise<ServiceActionState> {
  const user = await requireProvider()

  const [service] = await db
    .select({
      id: services.id,
      name: services.name,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
    })
    .from(services)
    .where(and(eq(services.id, input.serviceId), eq(services.active, true)))
    .limit(1)

  if (!service) return { error: 'That service is not available.' }

  const problem = validate(input.price, input.durationMins, service)
  if (problem) return { error: problem }

  const [existing] = await db
    .select({ id: providerServices.id })
    .from(providerServices)
    .where(
      and(
        eq(providerServices.providerId, user.id),
        eq(providerServices.serviceId, input.serviceId),
      ),
    )
    .limit(1)

  // The unique index on (provider_id, service_id) would reject this anyway; catching it here
  // turns a constraint violation into a sentence.
  if (existing) return { error: `${service.name} is already on your profile.` }

  await db.insert(providerServices).values({
    providerId: user.id,
    serviceId: input.serviceId,
    price: input.price.toFixed(2),
    durationMins: input.durationMins,
    isActive: true,
  })

  revalidatePath('/app/services')
  return { success: `${service.name} added.` }
}
