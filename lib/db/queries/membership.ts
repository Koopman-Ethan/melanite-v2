import 'server-only'

import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  ledgerEntries,
  medicalDirectorCredentials,
  memberships,
  platformSettings,
  providers,
} from '@/lib/db/schema'

// The medical director arrangement.
//
// Two paths, and they are genuinely different things sharing one status field:
//   melanite — a $150/mo Stripe subscription; status mirrors the subscription
//   own      — the provider's own director, active once credentials and a signed
//              supervision agreement are on file
//
// `medicalDirectorStatus` is THE booking gate either way, which is why this page matters more
// than a billing screen usually would: it is the difference between working and not.

export interface MembershipView {
  type: (typeof providers.$inferSelect)['medicalDirectorType']
  status: (typeof providers.$inferSelect)['medicalDirectorStatus']
  /** Set only on the Melanite path. */
  renewalDate: Date | null
  cancelAtPeriodEnd: boolean
  startDate: Date | null
  cancelDate: Date | null
  hasStripeSubscription: boolean
  /** Own-director path: who they are, when their license lapses. */
  director: {
    name: string
    npi: string | null
    licenseNumber: string | null
    licenseState: string | null
    licenseExpiry: string | null
    credentials: string | null
    contactEmail: string | null
    contactPhone: string | null
  } | null
  /** Whether Melanite has configured the plan at all. v1 returns PRICE_NOT_CONFIGURED when
   *  this is missing; better to know before offering a button that cannot work. */
  planConfigured: boolean
}

export async function getMembership(providerId: string): Promise<MembershipView> {
  const [provider] = await db
    .select({
      type: providers.medicalDirectorType,
      status: providers.medicalDirectorStatus,
    })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)

  const [membership] = await db
    .select({
      renewalDate: memberships.renewalDate,
      cancelAtPeriodEnd: memberships.cancelAtPeriodEnd,
      startDate: memberships.startDate,
      cancelDate: memberships.cancelDate,
      stripeSubscriptionId: memberships.stripeSubscriptionId,
    })
    .from(memberships)
    .where(eq(memberships.providerId, providerId))
    .orderBy(desc(memberships.createdAt))
    .limit(1)

  const [director] = await db
    .select({
      name: medicalDirectorCredentials.name,
      npi: medicalDirectorCredentials.npi,
      licenseNumber: medicalDirectorCredentials.licenseNumber,
      licenseState: medicalDirectorCredentials.licenseState,
      licenseExpiry: medicalDirectorCredentials.licenseExpiry,
      credentials: medicalDirectorCredentials.credentials,
      contactEmail: medicalDirectorCredentials.contactEmail,
      contactPhone: medicalDirectorCredentials.contactPhone,
    })
    .from(medicalDirectorCredentials)
    .where(eq(medicalDirectorCredentials.providerId, providerId))
    .limit(1)

  const [settings] = await db
    .select({ priceId: platformSettings.medicalDirectorPriceId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return {
    type: provider?.type ?? null,
    status: provider?.status ?? 'none',
    renewalDate: membership?.renewalDate ?? null,
    cancelAtPeriodEnd: membership?.cancelAtPeriodEnd ?? false,
    startDate: membership?.startDate ?? null,
    cancelDate: membership?.cancelDate ?? null,
    hasStripeSubscription: Boolean(membership?.stripeSubscriptionId),
    director: director ?? null,
    planConfigured: Boolean(settings?.priceId),
  }
}

export interface MembershipCharge {
  id: string
  createdAt: Date
  amount: string
  entryType: string
  stripeInvoiceId: string | null
  /** Null for rows written before the plans were distinguished, which were all director. */
  plan: 'medical_director' | 'epicutis' | null
}

/** What the provider has actually paid Melanite for supervision.
 *
 *  v1 could not show this: membership revenue existed only in Stripe, with no ledger row
 *  anywhere, so a provider had no in-app record of what they had been charged. */
export async function getMembershipCharges(providerId: string): Promise<MembershipCharge[]> {
  return db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      amount: ledgerEntries.grossAmount,
      entryType: ledgerEntries.entryType,
      stripeInvoiceId: ledgerEntries.stripeInvoiceId,
      // Which subscription the charge was for. The ledger row points at the membership it
      // belongs to, so a provider holding both plans sees two distinct lines rather than a
      // column of "Medical director — monthly" that includes their Epicutis payments.
      plan: memberships.plan,
    })
    .from(ledgerEntries)
    .leftJoin(memberships, eq(memberships.id, ledgerEntries.subjectId))
    .where(
      and(eq(ledgerEntries.providerId, providerId), eq(ledgerEntries.source, 'membership')),
    )
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(24)
}

export interface EpicutisMembership {
  status: 'active' | 'past_due' | 'cancelled' | null
  renewalDate: Date | null
  cancelAtPeriodEnd: boolean
  configured: boolean
}

/** The Epicutis membership, which is NOT a booking gate.
 *
 *  Read separately from `getMembership` rather than folded into it. That function is about the
 *  medical director — the thing that decides whether a provider can work — and quietly widening
 *  it to cover an unrelated content subscription is how the two end up being treated as
 *  interchangeable somewhere downstream. */
export async function getEpicutis(providerId: string): Promise<EpicutisMembership> {
  const [row] = await db
    .select({
      status: memberships.status,
      renewalDate: memberships.renewalDate,
      cancelAtPeriodEnd: memberships.cancelAtPeriodEnd,
    })
    .from(memberships)
    .where(and(eq(memberships.providerId, providerId), eq(memberships.plan, 'epicutis')))
    .limit(1)

  const [settings] = await db
    .select({ priceId: platformSettings.epicutisPriceId })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1)

  return {
    status: row?.status ?? null,
    renewalDate: row?.renewalDate ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    configured: Boolean(process.env.STRIPE_EPICUTIS_PRICE_ID || settings?.priceId),
  }
}
