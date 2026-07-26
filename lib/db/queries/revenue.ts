import 'server-only'

import { desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { ledgerEntries, ledgerSource, providers, services } from '@/lib/db/schema'

// The whole point of the unified ledger.
//
// v1 answered this with a 429-line XanoScript endpoint that loaded every transaction with no
// date filter, did an N+1 booking -> provider_service -> service lookup per row, then ran
// nested per-provider and per-service loops in application code — and still only covered two
// of five revenue streams. Here it is aggregation in the database, covering all five.
//
// `melanite_cut` is the platform's revenue for every source, which is what the `payer` column
// buys us: client-paid rows carry a split, provider-paid rows put the whole amount on the cut
// with a zero payout. So SUM(melanite_cut) needs no per-source special casing. Refund rows
// carry negative amounts, so they net out of every figure automatically.

/** America/Denver is the business timezone. Month boundaries must be computed there, not in
 *  UTC, or late-evening transactions land in the wrong month. */
const MONTH = sql<string>`to_char(${ledgerEntries.createdAt} AT TIME ZONE 'America/Denver', 'YYYY-MM')`
const CURRENT_MONTH = sql`to_char(now() AT TIME ZONE 'America/Denver', 'YYYY-MM')`

export interface RevenueTotals {
  lifetimeRevenue: string
  monthRevenue: string
  lifetimeGross: string
  lifetimePayouts: string
}

export async function getRevenueTotals(): Promise<RevenueTotals> {
  const [row] = await db
    .select({
      lifetimeRevenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      monthRevenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}) filter (where ${MONTH} = ${CURRENT_MONTH}), 0)`,
      lifetimeGross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      lifetimePayouts: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}), 0)`,
    })
    .from(ledgerEntries)

  return row
}

export interface SourceRevenue {
  source: string
  revenue: string
  gross: string
  payouts: string
  entries: number
}

/** Every source in the enum, in a fixed order, so the breakdown is stable across renders. */
const ALL_SOURCES = ledgerSource.enumValues

/** The breakdown v1 could not produce at all — memberships and training had no ledger row,
 *  and room rentals lived in a third table with different column names.
 *
 *  Sources with no entries are returned as explicit zeros rather than omitted. `GROUP BY`
 *  only yields groups that exist, and a revenue stream silently vanishing from this list is
 *  precisely the failure this page exists to fix — "$0.00" and "missing" must not look alike. */
export async function getRevenueBySource(): Promise<SourceRevenue[]> {
  const rows = await db
    .select({
      source: ledgerEntries.source,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      payouts: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}), 0)`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.source)

  const bySource = new Map(rows.map((r) => [r.source as string, r]))

  return ALL_SOURCES.map(
    (source): SourceRevenue =>
      bySource.get(source) ?? {
        source,
        revenue: '0.00',
        gross: '0.00',
        payouts: '0.00',
        entries: 0,
      },
  ).sort((a, b) => Number(b.revenue) - Number(a.revenue))
}

export interface MonthlyRevenue {
  month: string
  revenue: string
  gross: string
}

export async function getMonthlySeries(limit = 12): Promise<MonthlyRevenue[]> {
  const rows = await db
    .select({
      month: MONTH,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
    })
    .from(ledgerEntries)
    .groupBy(MONTH)
    .orderBy(desc(MONTH))
    .limit(limit)

  return rows.reverse()
}

export interface ProviderRevenue {
  providerId: string | null
  providerName: string
  revenue: string
  payouts: string
  gross: string
  entries: number
}

export async function getRevenueByProvider(): Promise<ProviderRevenue[]> {
  return db
    .select({
      providerId: ledgerEntries.providerId,
      providerName: sql<string>`coalesce(${providers.firstName} || ' ' || ${providers.lastName}, 'Unattributed')`,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      payouts: sql<string>`coalesce(sum(${ledgerEntries.providerPayout}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .leftJoin(providers, eq(ledgerEntries.providerId, providers.id))
    .groupBy(ledgerEntries.providerId, providers.firstName, providers.lastName)
    .orderBy(desc(sql`sum(${ledgerEntries.melaniteCut})`))
}

export interface ServiceRevenue {
  serviceId: string | null
  serviceName: string
  revenue: string
  gross: string
  entries: number
}

/** Only booking and package revenue attributes to a service; membership, room rental and
 *  training legitimately have none. Those rows are excluded rather than bucketed as null. */
export async function getRevenueByService(): Promise<ServiceRevenue[]> {
  return db
    .select({
      serviceId: ledgerEntries.serviceId,
      serviceName: services.name,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .innerJoin(services, eq(ledgerEntries.serviceId, services.id))
    .groupBy(ledgerEntries.serviceId, services.name)
    .orderBy(desc(sql`sum(${ledgerEntries.melaniteCut})`))
}

export interface RecentEntry {
  id: string
  createdAt: Date
  source: string
  entryType: string
  payer: string
  gross: string
  melaniteCut: string
  providerName: string | null
  note: string | null
}

export async function getRecentEntries(limit = 15): Promise<RecentEntry[]> {
  return db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      source: ledgerEntries.source,
      entryType: ledgerEntries.entryType,
      payer: ledgerEntries.payer,
      gross: sql<string>`${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}`,
      melaniteCut: ledgerEntries.melaniteCut,
      providerName: sql<
        string | null
      >`${providers.firstName} || ' ' || ${providers.lastName}`,
      note: ledgerEntries.note,
    })
    .from(ledgerEntries)
    .leftJoin(providers, eq(ledgerEntries.providerId, providers.id))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)
}

/** Everything the admin revenue page needs, in parallel. */
export async function getAdminRevenue() {
  const [totals, bySource, byProvider, byService, series, recent] = await Promise.all([
    getRevenueTotals(),
    getRevenueBySource(),
    getRevenueByProvider(),
    getRevenueByService(),
    getMonthlySeries(),
    getRecentEntries(),
  ])

  return { totals, bySource, byProvider, byService, series, recent }
}
