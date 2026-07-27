import 'server-only'

import { and, asc, eq, gte, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { bookings, providerServices, providers, services } from '@/lib/db/schema'

import { denverInstant, getLaserHours, type LaserHours } from './availability'

// The admin calendar.
//
// One laser, so this is a resource calendar rather than a per-person one — the question it
// answers is "what is the machine doing this week, and who has it", which no provider-scoped
// view can show. v1 answered it with GET /admin/bookings, which returned EVERY booking ever
// with no date filter and then did two extra queries per row to resolve the provider and
// service names. That is fine at 200 bookings and stops being fine well before it stops being
// used.
//
// Everything positional is computed here, in Denver wall-clock, and shipped as plain numbers.
// The client does layout only. Sending timestamps and letting the browser place them would put
// an admin in another timezone on a different calendar than the laser.

const OCCUPYING_STATUSES = new Set(['upcoming', 'completed'])

export interface CalendarBooking {
  id: string
  /** Denver calendar day, `YYYY-MM-DD`. */
  day: string
  /** Minutes from Denver midnight. Clamped to the day, so a booking crossing midnight renders
   *  on the day it starts rather than escaping the column. */
  startMinutes: number
  endMinutes: number
  /** Side-by-side placement when bookings overlap. On a single-laser business `lanes > 1` is a
   *  double-booking and should not exist — laying it out anyway is what makes it visible
   *  instead of hiding one block behind another. */
  lane: number
  lanes: number
  clientName: string
  providerId: string
  providerName: string
  serviceName: string
  colorHex: string | null
  price: string
  status: string
  paymentSource: string
  treatmentArea: string | null
  durationMins: number
  startLabel: string
  endLabel: string
}

export interface CalendarWeek {
  days: string[]
  hours: LaserHours
  bookings: CalendarBooking[]
  stats: {
    booked: number
    cancelled: number
    bookedMinutes: number
    openMinutes: number
    revenue: string
    /** Distinct providers with at least one booking this week. */
    providers: number
    doubleBooked: number
  }
}

/** Adds days to a `YYYY-MM-DD`. UTC arithmetic on the date parts only — no timezone is
 *  involved in "the day after the 3rd", and using a local Date here would break it across a
 *  DST boundary. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function denverToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now)
}

/** The Sunday on or before `date`. */
export function weekStartOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return addDays(date, -new Date(Date.UTC(y, m - 1, d)).getUTCDay())
}

const denverFields = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** An instant as Denver wall-clock: which day it lands on and how far into it. */
function denverPlacement(at: Date): { day: string; minutes: number } {
  const parts = denverFields.formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00'

  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`
}

export const minutesOf = (time: string) => {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** Greedy lane assignment within each cluster of overlapping bookings.
 *
 *  Mutates nothing outside the rows it is given. Sorted by start, each booking takes the first
 *  lane free at that moment; a gap with no overlap closes the cluster and resets the count. */
function assignLanes(rows: CalendarBooking[]): void {
  const byDay = new Map<string, CalendarBooking[]>()
  for (const row of rows) {
    const list = byDay.get(row.day)
    if (list) list.push(row)
    else byDay.set(row.day, [row])
  }

  for (const dayRows of byDay.values()) {
    dayRows.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes)

    let cluster: CalendarBooking[] = []
    let laneEnds: number[] = []

    const closeCluster = () => {
      for (const row of cluster) row.lanes = laneEnds.length
      cluster = []
      laneEnds = []
    }

    for (const row of dayRows) {
      // No lane is still occupied at this instant, so nothing here overlaps anything before it.
      if (laneEnds.every((end) => end <= row.startMinutes)) closeCluster()

      let lane = laneEnds.findIndex((end) => end <= row.startMinutes)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = row.endMinutes
      row.lane = lane
      cluster.push(row)
    }
    closeCluster()
  }
}

/** Every booking in the Denver week beginning `weekStart`, across all providers.
 *
 *  Cancelled and no-show bookings are included rather than filtered: they do not occupy the
 *  laser, but "did that get cancelled?" is a question this page should be able to answer. The
 *  caller decides whether to show them. */
export async function getCalendarWeek(weekStart: string): Promise<CalendarWeek> {
  const hours = await getLaserHours()
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const from = denverInstant(weekStart, '00:00')
  const to = denverInstant(addDays(weekStart, 7), '00:00')

  const rows = await db
    .select({
      id: bookings.id,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      clientName: bookings.clientName,
      treatmentArea: bookings.treatmentArea,
      durationMins: bookings.durationMins,
      price: bookings.price,
      status: bookings.status,
      paymentSource: bookings.paymentSource,
      providerId: providers.id,
      firstName: providers.firstName,
      lastName: providers.lastName,
      serviceName: services.name,
      colorHex: services.colorHex,
    })
    .from(bookings)
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    // Keyed on start time alone. A booking is drawn in the column it starts in, so one that
    // began before the week does not belong to this view even if it were still running.
    .where(and(gte(bookings.startTime, from), lt(bookings.startTime, to)))
    .orderBy(asc(bookings.startTime))

  const dayEnd = 24 * 60
  const entries: CalendarBooking[] = rows.map((r) => {
    const start = denverPlacement(r.startTime)
    const end = denverPlacement(r.endTime)
    // Same day, or clamped to midnight when it runs past it.
    const endMinutes = end.day === start.day ? end.minutes : dayEnd

    return {
      id: r.id,
      day: start.day,
      startMinutes: start.minutes,
      endMinutes,
      lane: 0,
      lanes: 1,
      clientName: r.clientName,
      providerId: r.providerId,
      providerName: `${r.firstName} ${r.lastName}`,
      serviceName: r.serviceName,
      colorHex: r.colorHex,
      price: r.price,
      status: r.status,
      paymentSource: r.paymentSource,
      treatmentArea: r.treatmentArea,
      durationMins: r.durationMins,
      startLabel: clock(start.minutes),
      endLabel: clock(endMinutes),
    }
  })

  // Lanes are computed over occupying bookings only. Including a cancellation would push a
  // real appointment sideways to make room for something that is not there.
  const occupying = entries.filter((e) => OCCUPYING_STATUSES.has(e.status))
  assignLanes(occupying)

  const bookedMinutes = occupying.reduce((sum, e) => sum + e.durationMins, 0)
  const revenueCents = occupying.reduce((sum, e) => sum + Math.round(Number(e.price) * 100), 0)

  return {
    days,
    hours,
    bookings: entries,
    stats: {
      booked: occupying.length,
      cancelled: entries.length - occupying.length,
      bookedMinutes,
      openMinutes: (minutesOf(hours.closeTime) - minutesOf(hours.openTime)) * 7,
      revenue: (revenueCents / 100).toFixed(2),
      providers: new Set(occupying.map((e) => e.providerId)).size,
      doubleBooked: occupying.filter((e) => e.lanes > 1).length,
    },
  }
}

/** What the laser is doing right now, for the header. Null outside of any booking. */
export function currentBooking(
  week: CalendarWeek,
  now: Date = new Date(),
): CalendarBooking | null {
  const { day, minutes } = denverPlacement(now)
  return (
    week.bookings.find(
      (b) =>
        OCCUPYING_STATUSES.has(b.status) &&
        b.day === day &&
        b.startMinutes <= minutes &&
        b.endMinutes > minutes,
    ) ?? null
  )
}

/** The next booking on or after `now`, for the header when the laser is idle. */
export function nextBooking(week: CalendarWeek, now: Date = new Date()): CalendarBooking | null {
  const { day, minutes } = denverPlacement(now)
  return (
    week.bookings
      .filter((b) => OCCUPYING_STATUSES.has(b.status))
      .filter((b) => b.day > day || (b.day === day && b.startMinutes >= minutes))
      .sort((a, b) => a.day.localeCompare(b.day) || a.startMinutes - b.startMinutes)[0] ?? null
  )
}
