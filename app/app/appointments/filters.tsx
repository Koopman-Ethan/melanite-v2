'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/cn'

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
] as const

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Filters live in the URL rather than component state, so a filtered view can be linked,
 *  bookmarked, and survives a refresh — and the server does the filtering. v1 held these in
 *  Wized variables and filtered the already-downloaded list in the browser. */
/** Counts per status, keyed by the same values as STATUSES. Declared here rather than
 *  imported from the query module: that one is `server-only`, and a client component should
 *  not reach into it even for a type. */
export interface StatusCounts {
  upcoming: number
  completed: number
  cancelled: number
  no_show: number
}

export function Filters({
  months,
  serviceOptions,
  counts,
}: {
  months: string[]
  serviceOptions: Array<{ id: string; name: string; isActive: boolean }>
  counts: StatusCounts
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  const status = params.get('status') ?? ''
  const month = params.get('month') ?? ''
  const service = params.get('service') ?? ''

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => set('status', s.value)}
            aria-pressed={status === s.value}
            className={cn(
              'rounded-field border px-3 py-1.5 text-xs transition-colors',
              status === s.value
                ? 'border-gold bg-gold/10 text-gold'
                : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-secondary',
            )}
          >
            {s.label}
            {/* No opacity. The count inherits the button's own colour, which is already the
                de-emphasised end of the ink ramp on an unselected filter — dimming it further
                put it under AA at 12px, the exact failure the ramp was raised to fix. Weight
                and spacing separate it from the label instead. */}
            {s.value !== '' && (
              <span className="ml-1.5 font-medium tabular-nums">{counts[s.value]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={month}
          onChange={(e) => set('month', e.target.value)}
          aria-label="Filter by month"
          className="rounded-field border border-line bg-surface px-3 py-1.5 text-xs text-ink-secondary"
        >
          <option value="">Any month</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>

        <select
          value={service}
          onChange={(e) => set('service', e.target.value)}
          aria-label="Filter by service"
          className="rounded-field border border-line bg-surface px-3 py-1.5 text-xs text-ink-secondary"
        >
          <option value="">Any service</option>
          {serviceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isActive ? '' : ' (inactive)'}
            </option>
          ))}
        </select>

        {(status || month || service) && (
          <button
            type="button"
            onClick={() => router.push(pathname, { scroll: false })}
            className="rounded-field px-3 py-1.5 text-xs text-ink-faint underline-offset-4 hover:text-ink-secondary hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  )
}
