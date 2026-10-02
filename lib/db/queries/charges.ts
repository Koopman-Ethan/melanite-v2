import 'server-only'

import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, ledgerEntries, services } from '@/lib/db/schema'

// What a provider pays Melanite.
//
// The exact inverse of `earnings.ts`, and the schema already named it: "provider charges =
// SUM(gross_amount) WHERE payer = 'provider'". Under the rental model that is the whole of the
// financial relationship — Melanite rents out a machine and a room and bills for them, and the
// money a provider makes from their own clients never passes through here at all.
//
// ONE FILTER CARRIES THIS FILE: `payer = 'provider'`. The earnings page had to add that filter
// late, after a provider's own bills turned up on their earnings list each showing a $0.00 share.
// Here it is the premise rather than an exclusion, which is the right way round.
//
// NOTHING IS EVER OUTSTANDING, and the page says so rather than implying a balance. A rental fee
// is taken when the slot is reserved and a booking whose card declines does not exist, so there is
// no such thing as an unpaid session. What a provider needs from this page is what left their
// card and why — not a bill.
//
// Refunds are negative rows on both `gross_amount` and `melanite_cut`, so every sum here nets
// them off without needing to know which entry types to subtract.

const PROVIDER_PAID = sql`${ledgerEntries.payer} = 'provider'`
const MONTH = sql<string>`to_char(${ledgerEntries.createdAt} AT TIME ZONE 'America/Denver', 'YYYY-MM')`
const CURRENT_MONTH = sql`to_char(now() AT TIME ZONE 'America/Denver', 'YYYY-MM')`

export interface ChargeTotals {
  /** Everything the provider has paid Melanite, all sources. */
  allLifetime: string
  allMonth: string
  /** Laser rent specifically — per-session fees and packs. */
  rentalLifetime: string
  rentalMonth: string
  /** The standing costs: room rental, medical direction, Epicutis. Separated because they
   *  arrive whether or not the provider books anything, which makes them a different kind of
   *  number to plan around. */
  recurringLifetime: string
  recurringMonth: string
  /** Sessions rented this month, for "what did that work out at per session". */
  sessionsMonth: number
}

export async function getChargeTotals(providerId: string): Promise<ChargeTotals> {
  const RENTAL = sql`${ledgerEntries.source} = 'rental_fee'`
  const RECURRING = sql`${ledgerEntries.source} in ('room_rental', 'membership', 'epicutis')`

  const [row] = await db
    .select({
      allLifetime: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}), 0)`,
      allMonth: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${MONTH} = ${CURRENT_MONTH}), 0)`,
      rentalLifetime: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${RENTAL}), 0)`,
      rentalMonth: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${RENTAL} and ${MONTH} = ${CURRENT_MONTH}), 0)`,
      recurringLifetime: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${RECURRING}), 0)`,
      recurringMonth: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${RECURRING} and ${MONTH} = ${CURRENT_MONTH}), 0)`,
      // Counted off the booking subject rather than the row count, so a pack purchase — one row
      // covering several sessions — does not read as one session.
      sessionsMonth: sql<number>`count(*) filter (
        where ${RENTAL} and ${ledgerEntries.subjectType} = 'booking'
          and ${ledgerEntries.entryType} = 'purchase' and ${MONTH} = ${CURRENT_MONTH}
      )::int`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.providerId, providerId), PROVIDER_PAID))

  return row
}

export interface ChargeMonth {
  month: string
  rental: string
  recurring: string
}

export async function getChargeSeries(providerId: string, limit = 12): Promise<ChargeMonth[]> {
  const rows = await db
    .select({
      month: MONTH,
      rental: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${ledgerEntries.source} = 'rental_fee'), 0)`,
      recurring: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}) filter (where ${ledgerEntries.source} in ('room_rental', 'membership', 'epicutis')), 0)`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.providerId, providerId), PROVIDER_PAID))
    .groupBy(MONTH)
    .orderBy(desc(MONTH))
    .limit(limit)

  return rows.reverse()
}

export interface ServiceCharges {
  serviceName: string
  paid: string
  sessions: number
}

/** Rent paid per service — which treatments the laser time actually went on.
 *
 *  Pack purchases are left out: a pack is bought against a TIER rather than a service, so
 *  attributing it to one would invent a figure. The sessions it pays for show up here as
 *  bookings with no charge of their own, which is why this reports what was paid separately from
 *  how many sessions were rented.
 */
export async function getChargesByService(providerId: string): Promise<ServiceCharges[]> {
  return db
    .select({
      serviceName: services.name,
      paid: sql<string>`coalesce(sum(${ledgerEntries.grossAmount}), 0)`,
      sessions: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .innerJoin(services, eq(ledgerEntries.serviceId, services.id))
    .where(
      and(
        eq(ledgerEntries.providerId, providerId),
        PROVIDER_PAID,
        eq(ledgerEntries.source, 'rental_fee'),
        eq(ledgerEntries.subjectType, 'booking'),
      ),
    )
    .groupBy(services.name)
    .orderBy(desc(sql`sum(${ledgerEntries.grossAmount})`))
}

export interface ChargeRow {
  id: string
  createdAt: Date
  source: string
  entryType: string
  amount: string
  serviceName: string | null
  startTime: Date | null
}

/** Every charge, newest first. The statement a provider checks a card line against. */
export async function getRecentCharges(providerId: string, limit = 30): Promise<ChargeRow[]> {
  return db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      source: ledgerEntries.source,
      entryType: ledgerEntries.entryType,
      amount: ledgerEntries.grossAmount,
      serviceName: services.name,
      // The appointment it was for, so a line reads "the Tuesday Brazilian" rather than a date
      // and an amount. Left join: a membership or a pack has no booking behind it.
      startTime: bookings.startTime,
    })
    .from(ledgerEntries)
    .leftJoin(
      bookings,
      and(eq(ledgerEntries.subjectType, 'booking'), eq(ledgerEntries.subjectId, bookings.id)),
    )
    .leftJoin(services, eq(ledgerEntries.serviceId, services.id))
    .where(and(eq(ledgerEntries.providerId, providerId), PROVIDER_PAID))
    .orderBy(desc(ledgerEntries.createdAt))
    .limit(limit)
}

export async function getCharges(providerId: string) {
  const [totals, series, byService, recent] = await Promise.all([
    getChargeTotals(providerId),
    getChargeSeries(providerId),
    getChargesByService(providerId),
    getRecentCharges(providerId),
  ])

  return { totals, series, byService, recent }
}
