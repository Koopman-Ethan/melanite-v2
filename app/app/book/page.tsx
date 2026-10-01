import { eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import Link from 'next/link'

import { BookingGates } from '@/components/booking-gates'
import { bookingBlockedReasons, canBook, requireProvider } from '@/lib/auth/dal'
import { todayInDenver } from '@/lib/validation'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import {
  getAvailability,
  getBookableServices,
  getMonthAvailability,
} from '@/lib/db/queries/availability'
import { packBalancesFor } from '@/lib/rental/packs'
import { rentalFeeFor, tierForService } from '@/lib/rental-fees'

import { BookPanel } from './book-panel'

export const metadata: Metadata = { title: 'Book laser time · Melanite' }
export const dynamic = 'force-dynamic'


export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; service?: string; month?: string }>
}) {
  const user = await requireProvider()
  const params = await searchParams

  // The gates are shown rather than enforced by redirect. A blocked provider landing on an
  // empty page learns nothing; v1's equivalent was a 403 whose reason lived in an error string.
  if (!canBook(user)) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Book laser time</h1>
        </header>
        {/* A real apostrophe, not &rsquo; — this is a string prop, not JSX text, so an HTML
            entity would render literally. */}
        <BookingGates gates={bookingBlockedReasons(user)} heading="Booking isn’t available yet" />
      </main>
    )
  }

  const services = await getBookableServices(user.id)

  if (services.length === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Book laser time</h1>
        </header>
        <div className="rounded-card border border-dashed border-line p-8 text-center">
          <p className="text-sm text-ink-muted">
            You don&rsquo;t have any active services yet.
          </p>
          <Link
            href="/app/services"
            className="mt-3 inline-block text-sm text-gold underline-offset-4 hover:underline"
          >
            Set up your services →
          </Link>
        </div>
      </main>
    )
  }

  const selected =
    services.find((s) => s.providerServiceId === params.service) ?? services[0]
  const today = todayInDenver()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today
  // The calendar can be browsed ahead of the selected day, so the month is its own parameter
  // and only falls back to the selected date's month.
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : date.slice(0, 7)

  const [{ slots, hours }, monthAvailability, packs, [provider]] = await Promise.all([
    getAvailability(date, selected.durationMins),
    getMonthAvailability(month, selected.durationMins),
    packBalancesFor(user.id),
    db
      .select({
        revenueModel: providers.revenueModel,
        cardLast4: providers.billingCardLast4,
      })
      .from(providers)
      .where(eq(providers.id, user.id))
      .limit(1),
  ])

  // Melanite treating Melanite's own client pays no rent, so the whole fee panel is irrelevant
  // for the house account rather than showing it a charge of nothing.
  const payingRent = provider?.revenueModel !== 'house'

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Book laser time</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The laser is shared — open times reflect every provider&rsquo;s bookings, not just
          yours. Hours are {hours.openTime}–{hours.closeTime} Mountain.
        </p>
      </header>

      <BookPanel
        services={services.map((s) => ({
          providerServiceId: s.providerServiceId,
          name: s.name,
          category: s.category,
          durationMins: s.durationMins,
          // What Melanite charges the provider for the slot. Null means the service has no
          // published fee and cannot be booked — the form says so rather than letting them
          // find out after picking a time.
          rentalFeeCents: payingRent ? rentalFeeFor(s.name) : 0,
          tierKey: tierForService(s.name)?.key ?? null,
        }))}
        packs={packs.map((p) => ({
          tierKey: p.tierKey,
          label: p.label,
          sessionsRemaining: p.sessionsRemaining,
        }))}
        payingRent={payingRent}
        cardLast4={provider?.cardLast4 ?? null}
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
