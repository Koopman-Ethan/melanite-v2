'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { BookForm, type PackView, type ServiceView, type SlotView } from './book-form'
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
  durationMins,
  date,
  month,
  today,
  days,
  packs,
  payingRent,
  quotesNoFee,
  cardLast4,
  hasCard,
  termsAccepted,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  durationMins: number
  date: string
  month: string
  today: string
  days: DayView[]
  packs: PackView[]
  payingRent: boolean
  quotesNoFee?: boolean
  cardLast4: string | null
  /** Whether anything can be charged at all. `cardLast4` is for display and can be null even
   *  when a payment method exists. */
  hasCard: boolean
  termsAccepted: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = (values: Record<string, string>, drop: string[] = []) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) next.set(key, value)
    for (const key of drop) next.delete(key)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <BookForm
      services={services}
      slots={slots}
      selectedServiceId={selectedServiceId}
      durationMins={durationMins}
      date={date}
      month={month}
      today={today}
      days={days}
      packs={packs}
      payingRent={payingRent}
      quotesNoFee={quotesNoFee}
      cardLast4={cardLast4}
      hasCard={hasCard}
      termsAccepted={termsAccepted}
      // Changing the service drops any duration from the URL: the new service has its own
      // remembered length, and carrying the old number over would silently book 75 minutes of
      // underarms because that is how long their legs take.
      onServiceChange={(id) => set({ service: id }, ['mins'])}
      onDurationChange={(mins) => set({ mins: String(mins) })}
      // Picking a day keeps the calendar on that day's month, so the two can never disagree.
      onDateChange={(d) => set({ date: d, month: d.slice(0, 7) })}
      onMonthChange={(m) => set({ month: m })}
    />
  )
}
