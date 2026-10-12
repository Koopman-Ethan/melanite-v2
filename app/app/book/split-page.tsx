import Link from 'next/link'

import type { SessionUser } from '@/lib/auth/session'
import {
  getAvailability,
  getMonthAvailability,
  getPricedServices,
} from '@/lib/db/queries/availability'
import { todayInDenver } from '@/lib/validation'

import { SplitPanel } from './split-panel'

/** The booking page for a provider on the original 50/50 split.
 *
 *  Rendered from `page.tsx` rather than being its own route, so the URL, the gates and the
 *  "booking isn't available yet" screen stay in one place and cannot drift apart.
 *
 *  THE SERVICES ARE HERS, not the catalogue. `getBookableServices` reads `provider_services`,
 *  where her own price for each service lives — the column the rental model stopped reading and
 *  this restores to being load-bearing. The rental page shows every active service at the
 *  published rental fee; she sees what she offers at what she charges.
 *
 *  Restored on 12 October. Ethan found the gap testing as Leyla: she was being shown the rental
 *  dropdown with every price reading $0.00, which is true of a rental fee she will never pay and
 *  says nothing at all about what she charges her client.
 */
export async function SplitBookPage({
  user,
  params,
}: {
  user: SessionUser
  params: { date?: string; service?: string; month?: string }
}) {
  const services = await getPricedServices(user.id)

  if (services.length === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Book laser time</h1>
        </header>
        <div className="rounded-card border border-dashed border-line p-8 text-center">
          <p className="text-sm text-ink-muted">
            You don&rsquo;t have any priced services yet. Melanite needs your price to work out
            its half, so a session cannot be booked without one.
          </p>
          <Link
            href="/app/services"
            className="mt-3 inline-block text-sm text-gold underline-offset-4 hover:underline"
          >
            Set your prices →
          </Link>
        </div>
      </main>
    )
  }

  const selected = services.find((s) => s.providerServiceId === params.service) ?? services[0]
  const today = todayInDenver()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today
  // The calendar can be browsed ahead of the selected day, so the month is its own parameter
  // and only falls back to the selected date's month.
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : date.slice(0, 7)

  const [{ slots, hours }, monthAvailability] = await Promise.all([
    getAvailability(date, selected.durationMins),
    getMonthAvailability(month, selected.durationMins),
  ])

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Book laser time</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The laser is shared — open times reflect every provider&rsquo;s bookings, not just
          yours. Hours are {hours.openTime}&ndash;{hours.closeTime} Mountain.
        </p>
        {/* Said plainly on the page she books from, because it is the whole of her arrangement
            and the one thing that differs from everybody else's. */}
        <p className="mt-2 text-xs text-ink-faint">
          You charge your own prices and Melanite keeps half. No rental fee is ever charged to
          you.
        </p>
      </header>

      <SplitPanel
        services={services}
        slots={slots.map((s) => ({
          startTime: s.startTime.toISOString(),
          available: s.available,
          reason: s.reason,
        }))}
        selectedServiceId={selected.providerServiceId}
        date={date}
        month={month}
        today={today}
        days={monthAvailability.days}
      />
    </main>
  )
}
