import { eq } from 'drizzle-orm'
import type { Metadata } from 'next'

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
import { describePromotion, discountedCents, promotionFor } from '@/lib/promotions'
import { tierForService } from '@/lib/rental-fees'
import { activePromotions } from '@/lib/rental/promotions'
import { getLiveSchedule } from '@/lib/rental/schedule'
import { getProcessingRate } from '@/lib/db/queries/admin-tools'
import { grossUpForProcessing } from '@/lib/money'
import { paysRent } from '@/lib/revenue-model'
import { hasAcceptedRentalTerms } from '@/lib/rental-terms'

import { BookPanel } from './book-panel'

export const metadata: Metadata = { title: 'Book laser time · Melanite' }
export const dynamic = 'force-dynamic'


export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; service?: string; month?: string; mins?: string }>
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
          {/* Previously "you have no services yet", with a link to go and tick some. There is
              nothing to tick any more — every active service is bookable by everybody — so an
              empty list means the catalogue itself is empty, which is Melanite's problem. */}
          <p className="text-sm text-ink-muted">
            There are no bookable services right now. Melanite needs to add some.
          </p>
        </div>
      </main>
    )
  }

  // Keyed on the SERVICE, not on a provider_services row — there may not be one until they
  // book it for the first time.
  const selected = services.find((s) => s.serviceId === params.service) ?? services[0]

  // How long they want, which decides which slots fit. Defaults to what they took last time,
  // clamped to what the service allows so a hand-edited URL cannot book 10 hours of laser.
  const requestedMins = Number(params.mins)
  const durationMins = Number.isInteger(requestedMins)
    ? Math.min(Math.max(requestedMins, selected.minDurationMins), selected.maxDurationMins)
    : selected.durationMins
  const today = todayInDenver()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? '') ? params.date! : today
  // The calendar can be browsed ahead of the selected day, so the month is its own parameter
  // and only falls back to the selected date's month.
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : date.slice(0, 7)

  const [{ slots, hours }, monthAvailability, packs, schedule, promotions, [provider]] =
    await Promise.all([
    getAvailability(date, durationMins),
    getMonthAvailability(month, durationMins),
    packBalancesFor(user.id),
    getLiveSchedule(),
    activePromotions(),
    db
      .select({
        revenueModel: providers.revenueModel,
        cardLast4: providers.billingCardLast4,
        paymentMethodId: providers.billingPaymentMethodId,
        rentalTermsVersion: providers.rentalTermsVersion,
        rentalScheduleVersion: providers.rentalScheduleVersion,
        rentBasis: providers.rentBasis,
      })
      .from(providers)
      .where(eq(providers.id, user.id))
      .limit(1),
  ])

  /** The live fee for a service, read off the schedule already loaded above rather than
   *  queried per row — a provider with twenty services would otherwise be twenty round trips
   *  to price one dropdown.
   *
   *  PRICED FOR THE SELECTED DAY, which is why this is computed here rather than in the
   *  browser: the date lives in the URL and the server recomputes on every change, so a
   *  provider browsing to a week after a promotion ends sees the price return to normal
   *  without any discount arithmetic shipping to the client.
   *
   *  Returns what the card will take, and — only when a promotion is reducing it — what it
   *  would have taken, so the form can show the saving rather than merely a smaller number. */
  const feeFromSchedule = (
    serviceName: string,
  ): { chargeCents: number; wasCents: number | null; promotion: string | null } | null => {
    const tier = tierForService(serviceName)
    if (!tier) return null
    const listed = schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents
    const promo = promotionFor(tier.key, date, promotions)
    const net = discountedCents(listed, promo)

    // QUOTED WITH PROCESSING ON IT, because that is what the card is charged. The schedule is
    // what Melanite nets; a provider comparing the number here against their statement must
    // find the same figure, and "$60" against a $62.11 line is a support message every time.
    //
    // The same function the charge uses, from the same settings, so the two cannot drift —
    // which is the shape of every money bug in this codebase so far. The promotion is applied
    // to the NET before the gross-up, for the same reason: discounting the grossed-up figure
    // would quietly discount Melanite's processing recovery too.
    const up = (cents: number) =>
      grossUpForProcessing({
        netCents: cents,
        pct: processing.pct,
        fixedCents: processing.fixedCents,
      }).chargeCents

    return {
      chargeCents: up(net),
      wasCents: promo ? up(listed) : null,
      promotion: promo ? `${describePromotion(promo)} · ${promo.name}` : null,
    }
  }


  // Melanite treating Melanite's own client pays no rent, so the whole fee panel is irrelevant
  // for the house account rather than showing it a charge of nothing.
  const payingRent = !provider || paysRent(provider.revenueModel)

  // One read for the whole dropdown. See `feeFromSchedule`.
  const processing = await getProcessingRate()

  /** This provider is never quoted a fee, because Melanite does not work one out for them.
   *
   *  Distinct from "this service has no published price", which is a gap. This is a permanent
   *  property of the arrangement, and the form says so differently: an unpriced service cannot
   *  be booked, whereas these three book normally and find out the figure when Keoni sets it. */
  const quotesNoFee = provider?.rentBasis === 'keoni_sets'



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
        services={services.map((s) => {
          const quote = feeFromSchedule(s.name)
          return {
          serviceId: s.serviceId,
          name: s.name,
          category: s.category,
          durationMins: s.durationMins,
          minDurationMins: s.minDurationMins,
          maxDurationMins: s.maxDurationMins,
          // What Melanite charges the provider for the slot. Null means the service has no
          // published fee and cannot be booked — the form says so rather than letting them
          // find out after picking a time.
          // NO FEE AT ALL for a `keoni_sets` provider, and null is the right answer rather
          // than a missing one. Melanite derives nothing for them — Keoni reads their receipt
          // after the session and sets the figure — so any number quoted here would be
          // invented. The form reads null as "no fee set" and lets them book anyway; see
          // `quotesNoFee` below, which is what keeps that from looking like a fault.
          rentalFeeCents: payingRent ? (quotesNoFee ? null : (quote?.chargeCents ?? null)) : 0,
          // What it would have cost without the promotion, and what the promotion is called.
          // Both null unless one is running on this service for the selected day.
          rentalWasCents: payingRent && !quotesNoFee ? (quote?.wasCents ?? null) : null,
          promotion: payingRent && !quotesNoFee ? (quote?.promotion ?? null) : null,
          tierKey: tierForService(s.name)?.key ?? null,
          }
        })}
        packs={packs.map((p) => ({
          tierKey: p.tierKey,
          label: p.label,
          sessionsRemaining: p.sessionsRemaining,
        }))}
        payingRent={payingRent}
        quotesNoFee={quotesNoFee}
        cardLast4={provider?.cardLast4 ?? null}
        hasCard={Boolean(provider?.paymentMethodId)}
        termsAccepted={hasAcceptedRentalTerms(provider, schedule.version)}
        slots={slots.map((s) => ({
          startTime: s.startTime.toISOString(),
          available: s.available,
          reason: s.reason,
        }))}
        selectedServiceId={selected.serviceId}
        durationMins={durationMins}
        date={date}
        month={month}
        today={today}
        days={monthAvailability.days}
      />
    </main>
  )
}
