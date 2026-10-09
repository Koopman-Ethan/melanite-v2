import 'server-only'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { notHouseSql } from '@/lib/db/revenue-model'
import {
  bookings,
  ledgerEntries,
  ledgerSource,
  paymentMethod,
  platformSettings,
  providers,
  services,
} from '@/lib/db/schema'

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

export interface MethodRevenue {
  method: string
  revenue: string
  gross: string
  entries: number
}

/** How the money arrived. Stripe is only one rail: Cherry financing pays Melanite by ACH,
 *  Groupon remits on its own schedule, and some payments are cash or cheque. None of those
 *  produce a Stripe object, so a Stripe-only view understates real revenue.
 *
 *  Methods with no entries are returned as zeros, for the same reason `getRevenueBySource`
 *  does it — "we took no Cherry payments" and "Cherry is missing from this report" must not
 *  render identically. */
export async function getRevenueByMethod(): Promise<MethodRevenue[]> {
  const rows = await db
    .select({
      method: ledgerEntries.paymentMethod,
      revenue: sql<string>`coalesce(sum(${ledgerEntries.melaniteCut}), 0)`,
      gross: sql<string>`coalesce(sum(${ledgerEntries.grossAmount} + ${ledgerEntries.tipAmount}), 0)`,
      entries: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.paymentMethod)

  const byMethod = new Map(rows.map((r) => [r.method as string, r]))

  return paymentMethod.enumValues
    .map(
      (method): MethodRevenue =>
        byMethod.get(method) ?? { method, revenue: '0.00', gross: '0.00', entries: 0 },
    )
    .filter((r) => r.entries > 0 || r.method === 'stripe' || r.method === 'cherry' || r.method === 'groupon')
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

export interface OwedByProvider {
  providerId: string
  providerName: string
  appointments: number
  /** What the clients handed over, in total. */
  collected: string
  /** Melanite's half of it — the figure to invoice. */
  owed: string
  /** Oldest outstanding appointment, in days. Age is what makes one of these worth chasing. */
  oldestDays: number
}

/**
 * Money providers are holding on Melanite's behalf.
 *
 * A Groupon voucher, cash or a cheque is handed to the PROVIDER. They keep the whole amount at
 * the moment of the appointment, so Melanite's half is not a payout waiting to be sent — it is
 * a debt waiting to be collected, and it exists the instant the appointment is booked.
 *
 * Every other route settles itself: a card payment splits at Stripe, a package settles at
 * purchase, a room rental and a membership are charged to the provider directly. This is the
 * only direction of money in the whole system that nothing automatic will ever resolve, which
 * is why it needs somewhere to be seen rather than being derivable in principle.
 *
 * An appointment leaves this list the moment a ledger entry is written against it — recording
 * the payment IS the act of saying "collected". Cancelled appointments are excluded: nobody
 * owes anything for a treatment that did not happen.
 *
 * Cherry is deliberately absent. It is package financing, it pays Melanite directly, and the
 * debt runs the other way — a provider on this list for Cherry money would be asked for
 * something they never held.
 */
export async function getOwedByProvider(): Promise<OwedByProvider[]> {
  const rows = await db
    .select({
      providerId: bookings.providerId,
      providerName: sql<string>`${providers.firstName} || ' ' || ${providers.lastName}`,
      appointments: sql<number>`count(*)::int`,
      collected: sql<string>`coalesce(sum(${bookings.price}), 0)`,
      // `1 - providerSharePct`, because what Melanite is owed is MELANITE's share. The provider
      // keeps `providerSharePct`; `lib/money.ts` defines the cut as `gross * (1 - share)` and
      // this must not disagree with it.
      //
      // This read `* providerSharePct` until 2026-09-02 — the provider's half, not Melanite's.
      // Invisible for as long as the rate sat at the default 0.500, where the two are equal,
      // and wrong on this page the moment it moved. The test moves it on purpose.
      owed: sql<string>`coalesce(sum(${bookings.price}) * (1 - ${platformSettings.providerSharePct}), 0)`,
      oldestDays: sql<number>`coalesce(floor(extract(epoch from now() - min(${bookings.startTime})) / 86400), 0)::int`,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    // The share is configuration, not a constant. Cross-joined to the singleton settings row so
    // one number governs this and the ledger alike.
    .innerJoin(platformSettings, eq(platformSettings.id, 1))
    .where(
      and(
        eq(bookings.paymentSource, 'external'),
        sql`${bookings.externalMethod} <> 'cherry'`,
        sql`${bookings.status} <> 'cancelled'`,
        // Melanite's own appointments are not a debt Melanite owes itself. This query reads
        // `bookings` rather than the ledger, so it would pick one up the moment Keoni took a
        // cash or Groupon client — and hand her an invoice addressed to herself, counted into
        // a total she is meant to go and chase.
        // ...and NOT `sharesRevenueSql`. These are pre-cutover external bookings, thirteen of
        // which belong to providers who move to rent — narrowing this to the 50/50 three would
        // drop their rows and understate what Keoni is owed. See `notHouseSql`.
        notHouseSql(providers.revenueModel),
        sql`not exists (
          select 1 from ${ledgerEntries}
          where ${ledgerEntries}.subject_type = 'booking'
            and ${ledgerEntries}.subject_id = ${bookings}.id
        )`,
      ),
    )
    .groupBy(
      bookings.providerId,
      providers.firstName,
      providers.lastName,
      platformSettings.providerSharePct,
    )
    .orderBy(desc(sql`sum(${bookings.price})`))

  return rows
}

export interface LaserUse {
  providerId: string
  providerName: string
  /** Sessions this month and all time, counted off bookings rather than ledger rows so a
   *  pack-covered session is still a session. */
  sessionsMonth: number
  sessionsLifetime: number
  /** Rent actually taken for those sessions. Nets off refunds, so a no-show that was given
   *  back does not inflate it. */
  rentMonth: string
  rentLifetime: string
  /** Credited sessions used this month. These produce no charge, so without this column a
   *  provider working through a grant looks like one using the laser for free. */
  packSessionsMonth: number
}

/**
 * Who is using the laser, and what it brought in.
 *
 * The question the rental model makes central. Under the split, "revenue by provider" meant
 * whose clients spent the most, which was really a measure of their pricing. Now the machine is
 * the product and the useful question is how much of it each provider is taking — one booking a
 * week at $40 and twelve at $130 are the same line on a revenue chart and completely different
 * businesses to be renting to.
 *
 * Rent and sessions are counted SEPARATELY and from different places on purpose. Sessions come
 * from `bookings`, rent from `ledger_entries`. A provider working through credited sessions
 * shows use and no rent, which is correct — nothing was charged for them, by arrangement — and
 * the credited column is what stops that reading as a hole.
 */
export async function getLaserUse(): Promise<LaserUse[]> {
  const rows = await db.execute<{
    provider_id: string
    provider_name: string
    sessions_month: number
    sessions_lifetime: number
    rent_month: string
    rent_lifetime: string
    pack_sessions_month: number
  }>(sql`
    WITH denver_month AS (
      SELECT to_char(now() AT TIME ZONE 'America/Denver', 'YYYY-MM') AS ym
    ),
    sessions AS (
      SELECT b.provider_id,
             count(*)::int AS lifetime,
             count(*) FILTER (
               WHERE to_char(b.start_time AT TIME ZONE 'America/Denver', 'YYYY-MM')
                   = (SELECT ym FROM denver_month)
             )::int AS month,
             count(*) FILTER (
               WHERE to_char(b.start_time AT TIME ZONE 'America/Denver', 'YYYY-MM')
                   = (SELECT ym FROM denver_month)
                 AND EXISTS (
                   SELECT 1 FROM provider_pack_redemptions r
                    WHERE r.booking_id = b.id AND r.voided_at IS NULL
                 )
             )::int AS pack_month
        FROM bookings b
       WHERE b.payment_source = 'rental' AND b.status <> 'cancelled'
       GROUP BY b.provider_id
    ),
    rent AS (
      SELECT l.provider_id,
             coalesce(sum(l.melanite_cut), 0) AS lifetime,
             coalesce(sum(l.melanite_cut) FILTER (
               WHERE to_char(l.created_at AT TIME ZONE 'America/Denver', 'YYYY-MM')
                   = (SELECT ym FROM denver_month)
             ), 0) AS month
        FROM ledger_entries l
       WHERE l.source = 'rental_fee'
       GROUP BY l.provider_id
    )
    SELECT p.id                                              AS provider_id,
           p.first_name || ' ' || p.last_name                AS provider_name,
           coalesce(s.month, 0)                              AS sessions_month,
           coalesce(s.lifetime, 0)                           AS sessions_lifetime,
           coalesce(r.month, 0)::text                        AS rent_month,
           coalesce(r.lifetime, 0)::text                     AS rent_lifetime,
           coalesce(s.pack_month, 0)                         AS pack_sessions_month
      FROM providers p
      LEFT JOIN sessions s ON s.provider_id = p.id
      LEFT JOIN rent r     ON r.provider_id = p.id
     WHERE coalesce(s.lifetime, 0) > 0 OR coalesce(r.lifetime, 0) <> 0
     ORDER BY coalesce(r.month, 0) DESC, coalesce(s.month, 0) DESC
  `)

  return (rows.rows ?? []).map((r) => ({
    providerId: r.provider_id,
    providerName: r.provider_name,
    sessionsMonth: Number(r.sessions_month),
    sessionsLifetime: Number(r.sessions_lifetime),
    rentMonth: r.rent_month,
    rentLifetime: r.rent_lifetime,
    packSessionsMonth: Number(r.pack_sessions_month),
  }))
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
  const [totals, bySource, byMethod, byProvider, byService, series, recent, owed, laserUse] =
    await Promise.all([
      getRevenueTotals(),
      getRevenueBySource(),
      getRevenueByMethod(),
      getRevenueByProvider(),
      getRevenueByService(),
      getMonthlySeries(),
      getRecentEntries(),
      getOwedByProvider(),
      getLaserUse(),
    ])

  return { totals, bySource, byMethod, byProvider, byService, series, recent, owed, laserUse }
}
