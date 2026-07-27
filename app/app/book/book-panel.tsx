'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { BookForm, type ServiceView, type SlotView } from './book-form'
import type { DayView } from './month-calendar'

/** Holds the service/date/month selection in the URL and lets the server recompute
 *  availability.
 *
 *  Availability depends on all three, and it must come from the database rather than be
 *  filtered client-side: the laser is shared, so another provider's booking has to appear
 *  without this page having fetched it. Putting the selection in the URL means each change is
 *  an ordinary server render against current data, and the chosen day is linkable.
 */
export function BookPanel({
  services,
  slots,
  selectedServiceId,
  date,
  month,
  today,
  days,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  date: string
  month: string
  today: string
  days: DayView[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = (values: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) next.set(key, value)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <BookForm
      services={services}
      slots={slots}
      selectedServiceId={selectedServiceId}
      date={date}
      month={month}
      today={today}
      days={days}
      onServiceChange={(id) => set({ service: id })}
      // Picking a day keeps the calendar on that day's month, so the two can never disagree.
      onDateChange={(d) => set({ date: d, month: d.slice(0, 7) })}
      onMonthChange={(m) => set({ month: m })}
    />
  )
}
