import 'server-only'

import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  clients,
  prepaidBalances,
  prepaidCheckoutLinks,
  prepaidRedemptions,
} from '@/lib/db/schema'

export interface PrepaidBalance {
  id: string
  clientId: string
  clientName: string | null
  clientEmail: string | null
  originalAmount: string
  remainingAmount: string
  purchasedAt: Date | null
  status: 'active' | 'exhausted'
  purchaserName: string | null
  purchaserEmail: string | null
}

/** Every balance this provider has sold, spent and unspent.
 *
 *  Unspent first and oldest first within that, which is the order the money is actually spent
 *  in — a list that disagrees with the allocation order invites "why did it take from that
 *  one?". Exhausted balances sort last rather than being filtered out: with no expiry and no
 *  refunds, a used-up balance is the only record that the client ever prepaid. */
export async function getPrepaidBalances(providerId: string): Promise<PrepaidBalance[]> {
  const rows = await db
    .select({
      id: prepaidBalances.id,
      clientId: prepaidBalances.clientId,
      clientName: clients.name,
      clientEmail: clients.email,
      originalAmount: prepaidBalances.originalAmount,
      remainingAmount: prepaidBalances.remainingAmount,
      purchasedAt: prepaidBalances.purchasedAt,
      status: prepaidBalances.status,
      purchaserName: prepaidBalances.purchaserName,
      purchaserEmail: prepaidBalances.purchaserEmail,
    })
    .from(prepaidBalances)
    .innerJoin(clients, eq(prepaidBalances.clientId, clients.id))
    .where(eq(prepaidBalances.providerId, providerId))
    .orderBy(
      // `status` alone would not do it: a balance can read active with nothing left for the
      // instant between the last claim and the status update.
      sql`case when ${prepaidBalances.remainingAmount} > 0 then 0 else 1 end`,
      asc(prepaidBalances.purchasedAt),
    )

  return rows
}

/** Spendable balances for one client, in the order they will be spent.
 *
 *  This is the read that `bookFromPrepaid` allocates against. It is deliberately NOT the guard —
 *  the claim happens atomically per balance at write time. Two providers booking the same client
 *  at once would both see the same money here, and only one of them will get it. */
export async function getSpendableBalances(
  providerId: string,
  clientId: string,
): Promise<Array<{ id: string; remainingAmount: string; purchasedAt: Date | null }>> {
  return db
    .select({
      id: prepaidBalances.id,
      remainingAmount: prepaidBalances.remainingAmount,
      purchasedAt: prepaidBalances.purchasedAt,
    })
    .from(prepaidBalances)
    .where(
      and(
        eq(prepaidBalances.providerId, providerId),
        eq(prepaidBalances.clientId, clientId),
        eq(prepaidBalances.status, 'active'),
        sql`${prepaidBalances.remainingAmount} > 0`,
      ),
    )
    .orderBy(asc(prepaidBalances.purchasedAt))
}

export interface PrepaidDraw {
  bookingId: string
  amountApplied: string
  redeemedAt: Date
  voidedAt: Date | null
  clientName: string
  startTime: Date
  bookingStatus: string
}

/** What a balance has been spent on. Voided draws are returned rather than filtered — "that
 *  appointment was cancelled and the money came back" is the question this list answers. */
export async function getPrepaidDraws(balanceId: string): Promise<PrepaidDraw[]> {
  return db
    .select({
      bookingId: prepaidRedemptions.bookingId,
      amountApplied: prepaidRedemptions.amountApplied,
      redeemedAt: prepaidRedemptions.redeemedAt,
      voidedAt: prepaidRedemptions.voidedAt,
      clientName: bookings.clientName,
      startTime: bookings.startTime,
      bookingStatus: sql<string>`${bookings.status}`,
    })
    .from(prepaidRedemptions)
    .innerJoin(bookings, eq(prepaidRedemptions.bookingId, bookings.id))
    .where(eq(prepaidRedemptions.prepaidBalanceId, balanceId))
    .orderBy(desc(prepaidRedemptions.redeemedAt))
}

export interface PendingPrepaidLink {
  id: string
  token: string
  amount: string
  clientName: string | null
  clientEmail: string | null
  purchaserName: string | null
  createdAt: Date
  expiresAt: Date
}

/** Links sent and not yet paid. The chase list — without it a link that was never opened looks
 *  exactly like one that was, which is the gap `cherryStartedAt` exists to close elsewhere. */
export async function getPendingPrepaidLinks(providerId: string): Promise<PendingPrepaidLink[]> {
  return db
    .select({
      id: prepaidCheckoutLinks.id,
      token: prepaidCheckoutLinks.token,
      amount: prepaidCheckoutLinks.amount,
      clientName: clients.name,
      clientEmail: clients.email,
      purchaserName: prepaidCheckoutLinks.purchaserName,
      createdAt: prepaidCheckoutLinks.createdAt,
      expiresAt: prepaidCheckoutLinks.expiresAt,
    })
    .from(prepaidCheckoutLinks)
    .innerJoin(clients, eq(prepaidCheckoutLinks.clientId, clients.id))
    .where(
      and(
        eq(prepaidCheckoutLinks.providerId, providerId),
        eq(prepaidCheckoutLinks.status, 'pending'),
      ),
    )
    .orderBy(desc(prepaidCheckoutLinks.createdAt))
}

/** Clients this provider has dealt with, for the picker when selling a balance.
 *
 *  Drawn from their own bookings and their own balances rather than the whole `clients` table,
 *  which is shared across every provider — offering one provider's client list to another is a
 *  disclosure, not a convenience. */
export async function getProviderClients(
  providerId: string,
): Promise<Array<{ id: string; name: string | null; email: string | null; phone: string | null }>> {
  return db
    .selectDistinct({
      id: clients.id,
      name: clients.name,
      email: clients.email,
      phone: clients.phone,
    })
    .from(clients)
    .where(
      sql`exists (
            select 1 from ${bookings}
            where ${bookings.clientId} = ${clients.id}
              and ${bookings.providerId} = ${providerId}
          )
          or exists (
            select 1 from ${prepaidBalances}
            where ${prepaidBalances.clientId} = ${clients.id}
              and ${prepaidBalances.providerId} = ${providerId}
          )`,
    )
    .orderBy(asc(clients.name))
}

/** Total unspent credit this provider has outstanding.
 *
 *  Worth surfacing rather than leaving as a sum of rows: with no expiry, this is a running
 *  obligation to deliver treatment for money already received and already split. */
export async function getOutstandingPrepaid(providerId: string): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${prepaidBalances.remainingAmount}), 0)::numeric(10,2)`,
    })
    .from(prepaidBalances)
    .where(
      and(eq(prepaidBalances.providerId, providerId), eq(prepaidBalances.status, 'active')),
    )

  return row?.total ?? '0.00'
}
