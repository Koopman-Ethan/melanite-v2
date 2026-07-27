'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { BookForm, type ServiceView, type SlotView } from './book-form'

/** Holds the service/date selection in the URL and lets the server recompute availability.
 *
 *  Availability depends on both, and it must come from the database rather than be filtered
 *  client-side: the laser is shared, so another provider's booking has to appear without this
 *  page having fetched it. Putting the selection in the URL means each change is an ordinary
 *  server render against current data, and the chosen day is linkable.
 */
export function BookPanel({
  services,
  slots,
  selectedServiceId,
  date,
}: {
  services: ServiceView[]
  slots: SlotView[]
  selectedServiceId: string
  date: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    next.set(key, value)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <BookForm
      services={services}
      slots={slots}
      selectedServiceId={selectedServiceId}
      date={date}
      onServiceChange={(id) => set('service', id)}
      onDateChange={(d) => set('date', d)}
    />
  )
}
