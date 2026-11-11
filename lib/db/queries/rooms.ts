import 'server-only'

import { and, asc, desc, eq, gte, inArray, lt, ne } from 'drizzle-orm'

import { db } from '@/lib/db'
import { addDays } from '@/lib/db/queries/admin-calendar'
import { providers, roomBookings, roomLeases, rooms } from '@/lib/db/schema'
import { getContractStates } from '@/lib/rooms/contracts'
import { completedTerm, contractEndsOn } from '@/lib/rooms/lease-schedule'

// The rentable spaces (migration 0048).
//
// One of them is rented by the day and the rest by the month. The daily room keeps everything it
// had before there was more than one room — its own page, its half-day and full-day prices in
// `platform_settings` — and only gained a name.

/** The room the per-day booking flow rents. Every room booking written before 0048 is this one,
 *  and it is `room_bookings.room_id`'s default. */
export const DAILY_ROOM_ID = 'daily'

export interface Room {
  id: string
  name: string
  kind: 'daily' | 'monthly'
  monthlyPriceCents: number | null
}

/** Every space still offered, in Keoni's order. */
export async function getRooms(): Promise<Room[]> {
  return db
    .select({
      id: rooms.id,
      name: rooms.name,
      kind: rooms.kind,
      monthlyPriceCents: rooms.monthlyPriceCents,
    })
    .from(rooms)
    .where(eq(rooms.active, true))
    .orderBy(asc(rooms.sort), asc(rooms.name))
}

/** A day, or half a day, a space is let to a provider. */
export interface RoomRentalEntry {
  id: string
  roomId: string
  day: string
  slotType: 'full' | 'am' | 'pm'
  providerName: string
  status: string
}

/** One week of every space, for Keoni's room calendar.
 *
 *  The rooms used to be a band across the top of the LASER calendar — which was right while there
 *  was one room and nothing else to show, and wrong once there were six spaces that have nothing
 *  to do with the laser (4 November). They have their own page now.
 *
 *  Fetched by rental_date rather than by timestamp range: a day room is sold as a named slot, and
 *  its start/end are derived from platform settings that can change. The date is what was bought. */
export async function getRoomWeek(
  weekStart: string,
): Promise<{ days: string[]; rooms: Room[]; rentals: RoomRentalEntry[] }> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const [spaces, rows] = await Promise.all([
    getRooms(),
    db
      .select({
        id: roomBookings.id,
        roomId: roomBookings.roomId,
        day: roomBookings.rentalDate,
        slotType: roomBookings.slotType,
        status: roomBookings.status,
        firstName: providers.firstName,
        lastName: providers.lastName,
      })
      .from(roomBookings)
      .innerJoin(providers, eq(roomBookings.providerId, providers.id))
      .where(
        and(
          gte(roomBookings.rentalDate, weekStart),
          lt(roomBookings.rentalDate, addDays(weekStart, 7)),
        ),
      )
      .orderBy(asc(roomBookings.rentalDate), asc(roomBookings.startAt)),
  ])

  const rentals = rows
    // A pending hold is someone mid-checkout, which is worth seeing — an abandoned one expires
    // and disappears on its own. A cancelled or refunded rental is not.
    .filter((r) => r.status !== 'cancelled' && r.status !== 'refunded')
    .map((r) => ({
      id: r.id,
      roomId: r.roomId,
      day: r.day,
      slotType: r.slotType,
      status: r.status,
      providerName: `${r.firstName} ${r.lastName}`,
    }))

  return { days, rooms: spaces, rentals }
}

export interface LeaseView {
  id: string
  roomId: string
  roomName: string
  providerId: string
  tenantName: string
  status: 'pending' | 'active' | 'past_due' | 'ended'
  startsOn: string
  termMonths: number
  monthlyCents: number
  depositCents: number
  depositStatus: 'held_outside' | 'charged' | 'refunded' | 'kept'
  noticeGivenOn: string | null
  /** The day rent stops. The contract's end unless notice or Keoni brought it forward. */
  endsOn: string | null
  /** The last day the signed contract covers. A renewal moves it. */
  contractEnd: string
  pastDueSince: Date | null
  /** Keoni's rule as a suggestion: refund when they stayed to the end of the contract, else keep. */
  suggestRefund: boolean
}

const LEASE_COLUMNS = {
  id: roomLeases.id,
  roomId: roomLeases.roomId,
  roomName: rooms.name,
  providerId: roomLeases.providerId,
  firstName: providers.firstName,
  lastName: providers.lastName,
  status: roomLeases.status,
  startsOn: roomLeases.startsOn,
  termMonths: roomLeases.termMonths,
  monthlyCents: roomLeases.monthlyCents,
  depositCents: roomLeases.depositCents,
  depositStatus: roomLeases.depositStatus,
  noticeGivenOn: roomLeases.noticeGivenOn,
  endsOn: roomLeases.endsOn,
  pastDueSince: roomLeases.pastDueSince,
}

function leaseQuery() {
  return db
    .select(LEASE_COLUMNS)
    .from(roomLeases)
    .innerJoin(rooms, eq(rooms.id, roomLeases.roomId))
    .innerJoin(providers, eq(providers.id, roomLeases.providerId))
}

function asLease(r: Awaited<ReturnType<typeof leaseQuery>>[number]): LeaseView {
  const { firstName, lastName, ...rest } = r
  return {
    ...rest,
    tenantName: `${firstName} ${lastName}`,
    contractEnd: contractEndsOn(r),
    suggestRefund: completedTerm(r),
  }
}

/** Leases still running, one per space at most. */
export async function getLiveLeases(): Promise<LeaseView[]> {
  return (await leaseQuery().where(ne(roomLeases.status, 'ended'))).map(asLease)
}

/** Ended leases whose deposit Keoni has not yet refunded or kept. */
export async function getDepositsToDecide(): Promise<LeaseView[]> {
  return (
    await leaseQuery()
      .where(and(eq(roomLeases.status, 'ended'), inArray(roomLeases.depositStatus, ['charged', 'held_outside'])))
      .orderBy(desc(roomLeases.endedAt))
  )
    .map(asLease)
    .filter((l) => l.depositCents > 0)
}

/** A tenant's own lease, if they have one running — what their Room Rental page leads with. */
export async function getMyLease(providerId: string): Promise<LeaseView | null> {
  const [row] = await leaseQuery()
    .where(and(eq(roomLeases.providerId, providerId), ne(roomLeases.status, 'ended')))
    .orderBy(desc(roomLeases.createdAt))
    .limit(1)
  return row ? asLease(row) : null
}

export interface TenantOption {
  id: string
  name: string
  hasCard: boolean
  /** A signed contract is on file and no lease has used it yet — what starting one needs. */
  waitingContractId: string | null
}

/** Who a lease can be started for: room tenants Keoni has invited, laser providers excluded —
 *  monthly rooms are a contract separate from the laser. */
export async function getTenantOptions(): Promise<TenantOption[]> {
  const rows = await db
    .select({
      id: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      email: providers.email,
      paymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(and(eq(providers.practiceType, 'room_only'), ne(providers.status, 'inactive')))
    .orderBy(asc(providers.firstName))
  const contracts = await getContractStates(rows.map((r) => r.id))
  return rows.map((r) => ({
    id: r.id,
    waitingContractId: contracts.get(r.id)?.waiting?.id ?? null,
    // Someone still in setup has no name yet; their email is how Keoni knows them.
    name: `${r.firstName} ${r.lastName}`.trim() || r.email,
    hasCard: Boolean(r.paymentMethodId),
  }))
}
