import 'server-only'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  clientPackageItems,
  clientPackages,
  ledgerEntries,
  packageRedemptions,
  services,
} from '@/lib/db/schema'

// Provider earnings.
//
// THE DISTINCTION THIS PAGE EXISTS TO PRESERVE, from v1's own note on GET /earnings:
//
//   "the 50/50 split settles at PURCHASE, so package payout is money received for sessions
//    not yet delivered (unearned revenue), not earnings for work done; mixing them would
//    misstate both."
//
// v1 kept them apart by accident of architecture — package money lived in a separate ledger,
// so it could not be summed with booking money without deliberate effort. v2's unified ledger
// removes that accident, which makes it EASIER to get wrong: a single SUM(provider_payout)
// now silently mixes delivered work with prepaid obligations. The separation here is
// therefore explicit, and every figure below says which side it is on.
//
// Also from v1, and easy to lose: booking payout ALREADY INCLUDES tips. `tips` is reported
// for information, not to be added to payout.

/** Booking payout is earned when the work happens; package payout arrives before it. */
const EARNED_SOURCES = sql`${ledgerEntries.source} in ('booking')`
const PREPAID_SOURCES = sql`${ledgerEntries.source} in ('package')`

const MONTH = sql<string>`to_char(${ledgerEntries.createdAt} AT TIME ZONE 'America/Denver', 'YYYY-MM')`
const CURRENT_MONTH = sql`to_char(now() AT TIME ZONE 'America/Denver', 'YYYY-MM')`

export interface EarningsTotals {
  /** Work delivered — booking payouts. Includes tips, per v1's split maths. */
  earnedLifetime: string
  earnedMonth: string
  /** Received at purchase for package sessions, delivered or not. */
  prepaidLifetime: string
  prepaidMonth: string
  /** Informational: tips are already inside the payout figures above. */
  tipsLifetime: string
  tipsMonth: string
  /** Booking payouts Stripe has not yet swept to the provider's bank.
   *
   *  Package rows are excluded deliberately — a package purchase is a destination charge that
   *  settles immediately, so calling it "pending" would be false. */
  pendingPayout: string
}

export async function getEarningsTotals(providerId: string): Promise<EarningsTotals> {
  const [row] = await db
    .select({
      earnedLifetime: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${EARNED_SOURCES}), 0)`,
      earnedMonth: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${EARNED_SOURCES} and ${MONTH} = ${CURRENT_MONTH}), 0)`,
      prepaidLifetime: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${PREPAID_SOURCES}), 0)`,
      prepaidMonth: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${PREPAID_SOURCES} and ${MONTH} = ${CURRENT_MONTH}), 0)`,
      tipsLifetime: sql<string>`coalesce(sum(${ledgerEntries.tipAmount}), 0)`,
      tipsMonth: sql<string>`coalesce(sum(${ledgerEntries.tipAmount}) filter (where ${MONTH} = ${CURRENT_MONTH}), 0)`,
      pendingPayout: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${EARNED_SOURCES} and ${ledgerEntries.payoutStatus} = 'pending'), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.providerId, providerId))

  return row
}

/** Value of package sessions bought but not yet delivered.
 *
 *  This is the client-facing value of what is still owed, not the provider's share of it —
 *  matching v1's `unearned_value` so the two systems report the same number during cutover.
 *  Only ACTIVE packages count: an expired or refunded one owes nothing.
 */
export async function getUnearnedValue(providerId: string): Promise<{
  value: string
  sessionsRemaining: number
  activePackages: number
}> {
  const [row] = await db
    .select({
      value: sql<string>`coalesce(sum((${clientPackageItems.qtyTotal} - ${clientPackageItems.qtyUsed}) * ${clientPackageItems.perSessionValue}), 0)`,
      sessionsRemaining: sql<number>`coalesce(sum(${clientPackageItems.qtyTotal} - ${clientPackageItems.qtyUsed}), 0)::int`,
      activePackages: sql<number>`count(distinct ${clientPackages.id})::int`,
    })
    .from(clientPackageItems)
    .innerJoin(clientPackages, eq(clientPackageItems.clientPackageId, clientPackages.id))
    .where(
      and(
        eq(clientPackages.providerId, providerId),
        eq(clientPackages.status, 'active'),
        sql`${clientPackageItems.qtyTotal} > ${clientPackageItems.qtyUsed}`,
      ),
    )

  return row
}

/** Package sessions actually delivered — the counterpart to unearned value. Voided
 *  redemptions are excluded, and so are those whose booking was cancelled. */
export async function getSessionsRedeemed(providerId: string): Promise<{
  lifetime: number
  month: number
}> {
  const [row] = await db
    .select({
      lifetime: sql<number>`count(*)::int`,
      month: sql<number>`count(*) filter (
        where to_char(${bookings.startTime} AT TIME ZONE 'America/Denver', 'YYYY-MM')
            = to_char(now() AT TIME ZONE 'America/Denver', 'YYYY-MM')
      )::int`,
    })
    .from(packageRedemptions)
    .innerJoin(bookings, eq(packageRedemptions.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.providerId, providerId),
        isNull(packageRedemptions.voidedAt),
        sql`${bookings.status} <> 'cancelled'`,
      ),
    )

  return row
}

export interface EarningsMonth {
  month: string
  earned: string
  prepaid: string
  tips: string
}

export async function getEarningsSeries(
  providerId: string,
  limit = 12,
): Promise<EarningsMonth[]> {
  const rows = await db
    .select({
      month: MONTH,
      earned: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${EARNED_SOURCES}), 0)`,
      prepaid: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}) filter (where ${PREPAID_SOURCES}), 0)`,
      tips: sql<string>`coalesce(sum(${ledgerEntries.tipAmount}), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.providerId, providerId))
    .groupBy(MONTH)
    .orderBy(desc(MONTH))
    .limit(limit)

  return rows.reverse()
}

export interface ServiceEarnings {
  serviceName: string
  payout: string
  gross: string
  count: number
}

/** Per-service, from booking work only. Package purchases do not attribute to a service in
 *  the ledger — v1 apportioned them across a template's line items by value share, which is
 *  an estimate presented alongside measured figures. Left out rather than mixed in. */
export async function getEarningsByService(providerId: string): Promise<ServiceEarnings[]> {
  return db
    .select({
      serviceName: services.name,
      payout: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .innerJoin(services, eq(ledgerEntries.serviceId, services.id))
    .where(and(eq(ledgerEntries.providerId, providerId), EARNED_SOURCES))
    .groupBy(services.name)
    .orderBy(desc(sql`sum(${ledgerEntries.providerPayout})`))
}

export interface PayoutRow {
  id: string
  createdAt: Date
  source: string
  entryType: string
  gross: string
  tip: string
  payout: string
  payoutStatus: string
  payoutDate: string | null
  clientName: string | null
  serviceName: string | null
}

export async function getRecentPayouts(providerId: string, limit = 20): Promise<PayoutRow[]> {
  return db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      source: ledgerEntries.source,
      entryType: ledgerEntries.entryType,
      gross: sql<string>`${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}`,
      tip: ledgerEntries.tipAmount,
      payout: ledgerEntries.providerPayout,
      payoutStatus: ledgerEntries.payoutStatus,
      payoutDate: ledgerEntries.payoutDate,
      clientName: bookings.clientName,
      serviceName: services.name,
    })
    .from(ledgerEntries)
    .leftJoin(
      bookings,
      and(eq(ledgerEntries.subjectType, 'booking'), eq(ledgerEntries.subjectId, bookings.id)),
    )
    .leftJoin(services, eq(ledgerEntries.serviceId, services.id))
    .where(eq(ledgerEntries.providerId, providerId))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)
}

export async function getEarnings(providerId: string) {
  const [totals, unearned, redeemed, series, byService, recent] = await Promise.all([
    getEarningsTotals(providerId),
    getUnearnedValue(providerId),
    getSessionsRedeemed(providerId),
    getEarningsSeries(providerId),
    getEarningsByService(providerId),
    getRecentPayouts(providerId),
  ])

  return { totals, unearned, redeemed, series, byService, recent }
}
