'use client'

import { cn } from '@/lib/cn'

// Why a calendar and not a date field.
//
// The laser is shared, so "is the 14th any good?" is not a question the provider can answer
// from their own schedule — the day may be full because of someone else entirely. A bare date
// input makes them pick a day, wait for a render, read an empty grid, and try again. The
// calendar answers it for the whole month at once.
//
// The counts are duration-specific, so a 30-minute service and a two-hour one show different
// calendars. That is the honest version: a day with three scattered 30-minute gaps is wide open
// for one and useless for the other.

export interface DayView {
  date: string
  openSlots: number
  fittingSlots: number
  past: boolean
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

const fullDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function MonthCalendar({
  month,
  days,
  selected,
  today,
  onSelect,
  onMonthChange,
}: {
  month: string
  days: DayView[]
  selected: string
  today: string
  onSelect: (date: string) => void
  onMonthChange: (month: string) => void
}) {
  const [y, m] = month.split('-').map(Number)
  const leading = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()

  // Past months are reachable but pointless — nothing in them is bookable.
  const atFloor = month <= today.slice(0, 7)

  return (
    <div className="rounded-card border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onMonthChange(addMonths(month, -1))}
          disabled={atFloor}
          aria-label="Previous month"
          className="rounded-field px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-overlay hover:text-ink-secondary disabled:cursor-not-allowed disabled:opacity-30"
        >
          ←
        </button>
        <span className="text-sm font-medium">{monthLabel(month)}</span>
        <button
          type="button"
          onClick={() => onMonthChange(addMonths(month, 1))}
          aria-label="Next month"
          className="rounded-field px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-overlay hover:text-ink-secondary"
        >
          →
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className="pb-1 text-center text-[10px] uppercase text-ink-faint">
            {d}
          </div>
        ))}

        {Array.from({ length: leading }, (_, i) => (
          <div key={`pad-${i}`} />
        ))}

        {days.map((day) => {
          const isSelected = day.date === selected
          const isToday = day.date === today
          const full = !day.past && day.openSlots === 0
          const disabled = day.past || full
          // Three bands, not a gradient: the provider is choosing between days, and "wide
          // open / some room / nearly full" is the distinction that changes the choice.
          const ratio = day.fittingSlots > 0 ? day.openSlots / day.fittingSlots : 0
          const band = ratio > 0.6 ? 'high' : ratio > 0.25 ? 'mid' : 'low'

          return (
            <button
              key={day.date}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(day.date)}
              aria-pressed={isSelected}
              aria-label={`${fullDate(day.date)} — ${
                day.past ? 'past' : full ? 'fully booked' : `${day.openSlots} open times`
              }`}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center rounded-field border text-sm tabular-nums transition-colors',
                isSelected
                  ? 'border-gold bg-gold text-gold-ink'
                  : disabled
                    ? 'cursor-not-allowed border-transparent text-ink-faint/40'
                    : 'border-line text-ink-secondary hover:border-gold hover:text-gold',
                isToday && !isSelected && 'ring-1 ring-inset ring-line-strong',
              )}
            >
              <span className={cn(full && !isSelected && 'line-through')}>
                {Number(day.date.slice(-2))}
              </span>

              {!disabled && (
                <span
                  aria-hidden
                  className={cn(
                    'mt-1 size-1.5 rounded-full',
                    isSelected
                      ? 'bg-gold-ink/60'
                      : band === 'high'
                        ? 'bg-success'
                        : band === 'mid'
                          ? 'bg-warning'
                          : 'bg-danger',
                  )}
                />
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-ink-faint">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-success" aria-hidden /> Wide open
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-warning" aria-hidden /> Some room
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-danger" aria-hidden /> Nearly full
        </span>
        <span className="flex items-center gap-1">
          <span className="text-ink-faint/40 line-through">00</span> Fully booked
        </span>
      </div>
    </div>
  )
}
