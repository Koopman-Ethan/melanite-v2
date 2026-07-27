'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/cn'
import type { CalendarBooking } from '@/lib/db/queries/admin-calendar'

// Layout only. Every position on this grid was computed on the server in Denver wall-clock —
// this component never touches a timestamp, which is what keeps an admin in another timezone
// looking at the same calendar as the laser.

const PX_PER_MIN = 1.1

const STATUS_STYLES: Record<string, string> = {
  upcoming: '',
  completed: 'opacity-90',
  cancelled: 'opacity-40 line-through',
  no_show: 'opacity-40',
}

const PAYMENT_LABELS: Record<string, string> = {
  checkout_link: 'Paid by link',
  package_redemption: 'Package session',
  comped: 'Comped',
}

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayHeading = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return {
    weekday: at.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    date: at.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' }),
    month: at.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
  }
}

/** Minutes into the Denver day, right now. Null until mounted — rendering it on the server
 *  would bake the build time into the page and hydrate to a different position. */
function useDenverNow(): { day: string; minutes: number } | null {
  const [now, setNow] = useState<{ day: string; minutes: number } | null>(null)

  useEffect(() => {
    const read = () => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Denver',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date())
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
      setNow({
        day: `${get('year')}-${get('month')}-${get('day')}`,
        minutes: Number(get('hour')) * 60 + Number(get('minute')),
      })
    }
    read()
    const timer = setInterval(read, 60_000)
    return () => clearInterval(timer)
  }, [])

  return now
}

function BookingBlock({
  booking,
  openMinutes,
  onSelect,
  selected,
}: {
  booking: CalendarBooking
  openMinutes: number
  onSelect: () => void
  selected: boolean
}) {
  const top = (booking.startMinutes - openMinutes) * PX_PER_MIN
  const height = Math.max((booking.endMinutes - booking.startMinutes) * PX_PER_MIN, 18)
  const width = 100 / booking.lanes
  const accent = booking.colorHex ?? 'var(--color-gold)'

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        top,
        height,
        left: `${booking.lane * width}%`,
        width: `calc(${width}% - 2px)`,
        borderLeftColor: accent,
        backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
      }}
      className={cn(
        'absolute overflow-hidden rounded-r border-l-2 px-1.5 py-1 text-left transition-shadow',
        'hover:z-10 hover:shadow-lg',
        selected && 'z-10 ring-1 ring-gold',
        STATUS_STYLES[booking.status] ?? '',
      )}
      title={`${booking.startLabel}–${booking.endLabel} · ${booking.clientName} · ${booking.serviceName} · ${booking.providerName}`}
    >
      <div className="truncate text-[11px] font-medium leading-tight text-ink">
        {booking.clientName}
      </div>
      {height > 30 && (
        <div className="truncate text-[10px] leading-tight text-ink-muted">
          {booking.providerName}
        </div>
      )}
      {height > 46 && (
        // ink-secondary, not ink-faint: this text sits on a service-coloured tint, so its
        // contrast varies with whatever hue that service was given. Measured at 4.06:1 on the
        // gold tint — the one case a flat token check cannot catch.
        <div className="truncate text-[10px] leading-tight text-ink-secondary">
          {booking.serviceName}
        </div>
      )}
    </button>
  )
}

export function WeekGrid({
  days,
  bookings,
  openTime,
  closeTime,
}: {
  days: string[]
  bookings: CalendarBooking[]
  openTime: string
  closeTime: string
}) {
  const [showCancelled, setShowCancelled] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const now = useDenverNow()

  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const openMinutes = toMinutes(openTime)
  const closeMinutes = toMinutes(closeTime)
  const gridHeight = (closeMinutes - openMinutes) * PX_PER_MIN

  const visible = bookings.filter(
    (b) => showCancelled || (b.status !== 'cancelled' && b.status !== 'no_show'),
  )
  const selected = bookings.find((b) => b.id === selectedId) ?? null

  const hourMarks: number[] = []
  for (let m = Math.ceil(openMinutes / 60) * 60; m < closeMinutes; m += 60) hourMarks.push(m)

  const hourLabel = (m: number) => {
    const h = Math.floor(m / 60)
    return `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'p' : 'a'}`
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show cancelled and no-shows
        </label>
        <p className="text-xs text-ink-faint">
          {openTime}–{closeTime} Mountain · one laser, all providers
        </p>
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-label="Weekly laser calendar"
        className="overflow-x-auto rounded-card border border-line bg-surface"
      >
        <div className="min-w-[720px]">
          {/* Day headings */}
          <div className="flex border-b border-line">
            <div className="w-12 shrink-0" />
            {days.map((day) => {
              const { weekday, date, month } = dayHeading(day)
              const isToday = now?.day === day
              return (
                <div
                  key={day}
                  className={cn(
                    'flex-1 border-l border-line px-2 py-2 text-center',
                    isToday && 'bg-gold/5',
                  )}
                >
                  <div
                    className={cn(
                      'text-[10px] uppercase tracking-wide',
                      isToday ? 'text-gold' : 'text-ink-muted',
                    )}
                  >
                    {weekday}
                  </div>
                  <div
                    className={cn(
                      'text-sm tabular-nums',
                      isToday ? 'font-semibold text-gold' : 'text-ink-secondary',
                    )}
                  >
                    {date}
                    {(date === '1' || day === days[0]) && (
                      <span className="ml-1 text-[10px] text-ink-faint">{month}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Timeline */}
          <div className="flex" style={{ height: gridHeight }}>
            <div className="relative w-12 shrink-0">
              {hourMarks.map((m) => (
                <span
                  key={m}
                  style={{ top: (m - openMinutes) * PX_PER_MIN }}
                  className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-ink-faint"
                >
                  {hourLabel(m)}
                </span>
              ))}
            </div>

            {days.map((day) => {
              const dayBookings = visible.filter((b) => b.day === day)
              const isToday = now?.day === day
              const nowTop =
                isToday && now.minutes >= openMinutes && now.minutes <= closeMinutes
                  ? (now.minutes - openMinutes) * PX_PER_MIN
                  : null

              return (
                <div
                  key={day}
                  className={cn(
                    'relative flex-1 border-l border-line',
                    isToday && 'bg-gold/[0.03]',
                  )}
                >
                  {hourMarks.map((m) => (
                    <div
                      key={m}
                      style={{ top: (m - openMinutes) * PX_PER_MIN }}
                      className="absolute inset-x-0 border-t border-line/40"
                    />
                  ))}

                  {dayBookings.map((b) => (
                    <BookingBlock
                      key={b.id}
                      booking={b}
                      openMinutes={openMinutes}
                      selected={selectedId === b.id}
                      onSelect={() => setSelectedId(selectedId === b.id ? null : b.id)}
                    />
                  ))}

                  {nowTop !== null && (
                    <div
                      style={{ top: nowTop }}
                      className="pointer-events-none absolute inset-x-0 z-20 border-t border-danger"
                    >
                      <span className="absolute -left-0.5 -top-1 size-1.5 rounded-full bg-danger" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {selected ? (
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-medium">{selected.clientName}</h3>
                <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                  {selected.status.replace('_', ' ')}
                </span>
                {selected.paymentSource !== 'checkout_link' && (
                  <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold">
                    {PAYMENT_LABELS[selected.paymentSource] ?? selected.paymentSource}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-ink-secondary">
                {selected.serviceName}
                {selected.treatmentArea && (
                  <span className="text-ink-faint"> · {selected.treatmentArea}</span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-ink-muted tabular-nums">
                {selected.startLabel}–{selected.endLabel}
                <span className="text-ink-faint"> ({selected.durationMins} min)</span>
              </p>
              <p className="mt-1.5 text-xs text-ink-faint">{selected.providerName}</p>
            </div>
            <div className="text-right text-lg font-semibold tabular-nums">
              {usd(selected.price)}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-center text-xs text-ink-faint">
          Select an appointment to see its details.
        </p>
      )}
    </div>
  )
}
