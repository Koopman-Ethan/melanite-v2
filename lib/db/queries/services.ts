import 'server-only'

import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providerServices, services } from '@/lib/db/schema'

export interface ProviderServiceRow {
  id: string
  serviceId: string
  name: string
  description: string | null
  price: string
  durationMins: number
  isActive: boolean
  /** Bounds come from the master catalog and constrain what the provider may set. */
  minDurationMins: number
  maxDurationMins: number
  suggestedDurationMins: number
  colorHex: string | null
  /** False when Melanite has retired the service platform-wide. The provider's row survives —
   *  history references it — but it cannot be booked, and no toggle of theirs will change
   *  that, so the UI has to say so rather than showing an enabled switch that does nothing. */
  offeredPlatformWide: boolean
  packageEligible: boolean
  advancedTierRequired: boolean
  /** Upcoming bookings against this configuration. Deactivating with appointments already on
   *  the calendar does not cancel them, and the provider should know that before they do it. */
  upcomingBookings: number
}

export async function getProviderServices(providerId: string): Promise<ProviderServiceRow[]> {
  return db
    .select({
      id: providerServices.id,
      serviceId: services.id,
      name: services.name,
      description: services.description,
      price: providerServices.price,
      durationMins: providerServices.durationMins,
      isActive: providerServices.isActive,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      suggestedDurationMins: services.suggestedDurationMins,
      colorHex: services.colorHex,
      offeredPlatformWide: services.active,
      packageEligible: services.packageEligible,
      advancedTierRequired: services.advancedTierRequired,
      upcomingBookings: sql<number>`(
        select count(*) from ${bookings}
        where ${bookings.providerServiceId} = ${providerServices.id}
          and ${bookings.status} = 'upcoming'
      )::int`,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(providerServices.providerId, providerId))
    .orderBy(asc(services.name))
}

export interface CatalogService {
  id: string
  name: string
  description: string | null
  suggestedDurationMins: number
  minDurationMins: number
  maxDurationMins: number
  advancedTierRequired: boolean
}

/** Catalog services this provider does NOT yet offer.
 *
 *  v1 has no path to this. POST /me/services requires onboarding_step == 4, so once a
 *  provider finishes onboarding they cannot add a service at all — Melanite has to do it for
 *  them. That is a gap rather than a decision, so v2 closes it. */
export async function getAvailableServices(providerId: string): Promise<CatalogService[]> {
  return db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      suggestedDurationMins: services.suggestedDurationMins,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      advancedTierRequired: services.advancedTierRequired,
    })
    .from(services)
    .leftJoin(
      providerServices,
      and(
        eq(providerServices.serviceId, services.id),
        eq(providerServices.providerId, providerId),
      ),
    )
    .where(and(eq(services.active, true), isNull(providerServices.id)))
    .orderBy(asc(services.name))
}
