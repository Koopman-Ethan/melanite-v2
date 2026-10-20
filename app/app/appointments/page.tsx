import type { Metadata } from 'next'
import { Suspense } from 'react'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import {
  getAppointmentCounts,
  getAppointments,
  getBookedMonths,
  getRentalBookingSummary,
  getProviderServiceOptions,
  type Appointment,
  type AppointmentStatus,
} from '@/lib/db/queries/appointments'
import { appOrigin } from '@/lib/stripe/config'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

import { AppointmentActions } from './appointment-actions'
import { closeoutWindowOpen } from '@/lib/end-of-use'
import { denverYmd, discountedCents, promotionFor } from '@/lib/promotions'
import { tierForService } from '@/lib/rental-fees'
import { sharesRevenue } from '@/lib/revenue-model'
import { getCheckoutSettings } from '@/lib/db/queries/checkout'
import { promotionsOwed } from '@/lib/rental/promotions'
import { getLiveSchedule } from '@/lib/rental/schedule'

import { SessionActions } from './session-actions'
import { PaymentLink } from './payment-link'
import { RentalBookedBanner } from './booked-banner'
import { Filters } from './filters'

export const metadata: Metadata = { title: 'Appointments · Melanite' }
export const dynamic = 'force-dynamic'

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  upcoming: 'border-info/40 bg-info/10 text-info',
  completed: 'border-success/40 bg-success/10 text-success',
  cancelled: 'border-line-strong bg-overlay text-ink-faint',
  no_show: 'border-danger/40 bg-danger/10 text-danger',
}

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  upcoming: 'Upcoming',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

const PAYMENT_LABELS: Record<Appointment['paymentSource'], string> = {
  checkout_link: 'Paid by link',
  external: 'Paid outside the app',
  package_redemption: 'Package session',
  prepaid: 'Prepaid balance',
  comped: 'Comped',
  // Not "unpaid". The provider paid Melanite rent for the slot; what their client paid them is
  // not something this app knows or shows.
  rental: 'Laser rental',
}

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayLabel = (d: Date) =>
  d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Denver',
  })

const timeLabel = (d: Date) =>
  d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

function AppointmentCard({
  appointment,
  origin,
  dueCents,
  lateCancellationHours,
  keoniSetsFee,
}: {
  appointment: Appointment
  origin: string
  /** From `platform_settings`. Cancelling with more notice than this asks for no reason, and
   *  nothing is owed — Keoni's rule of 12 October. */
  lateCancellationHours: number
  /** What this session WILL cost, for one that has not been swept yet. Null when the service
   *  has no published fee. */
  dueCents: number | null
  /** Their fee is set by Keoni from a receipt. Changes what a missing figure MEANS. */
  keoniSetsFee: boolean
}) {
  const discounted = appointment.discountType !== 'none' && Number(appointment.discountValue) > 0

  // Does THIS session owe rent? Not the same question as whether the provider pays rent.
  //
  // The three on `keoni_sets` still have pre-cutover appointments on this list, carrying a
  // client and a price, where the client paid Melanite through a checkout link and Melanite
  // took its half at the point of sale. Nothing is owed on one of those.
  const paysRentForThis = appointment.paymentSource === 'rental'

  // Which of the two peers this session gets. Both can be absent — a cancellation past its
  // close-out window offers neither, and the row draws nothing rather than an empty rule.
  const happened =
    appointment.status !== 'cancelled' &&
    appointment.status !== 'no_show' &&
    appointment.endTime <= new Date()

  const closeoutOffered = happened && closeoutWindowOpen(appointment)

  // INDEPENDENT OF THE CLOSE-OUT, which is the whole point of them being peers. It was briefly
  // suppressed while the close-out was still asking, on the theory that two prompts for the
  // same number is worse than one — true when the figure was a field buried inside the
  // checklist form, and false now that it is a labelled button beside it. Two buttons that say
  // what they do are not a duplicate question.
  //
  // It also outlives the close-out, which is the reason this matters: that one goes on a
  // cancellation, a no-show, and twelve hours after any session, and the figure is still owed
  // after all three.
  const receiptOffered = happened && keoniSetsFee && paysRentForThis

  // Has the rent been taken yet? Null means no ledger row, which since 12 October is the
  // ORDINARY state of a session for its first twelve hours rather than a fault.
  const unsettled = appointment.paymentSource === 'rental' && appointment.rentalCents === null

  return (
    <li className="rounded-card border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-medium">{appointment.clientName}</h3>
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                STATUS_STYLES[appointment.status],
              )}
            >
              {STATUS_LABELS[appointment.status]}
            </span>
            {appointment.paymentSource !== 'checkout_link' && (
              <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold">
                {PAYMENT_LABELS[appointment.paymentSource]}
              </span>
            )}
          </div>

          <p className="mt-1.5 text-sm text-ink-secondary">
            {appointment.serviceName}
            {appointment.treatmentArea && (
              <span className="text-ink-faint"> · {appointment.treatmentArea}</span>
            )}
          </p>

          <p className="mt-0.5 text-sm text-ink-muted tabular-nums">
            {dayLabel(appointment.startTime)} · {timeLabel(appointment.startTime)}–
            {timeLabel(appointment.endTime)}
            <span className="text-ink-faint"> ({appointment.durationMins} min)</span>
          </p>

          {(appointment.clientPhone || appointment.clientEmail) && (
            <p className="mt-1.5 text-xs text-ink-faint">
              {[appointment.clientPhone, appointment.clientEmail].filter(Boolean).join(' · ')}
            </p>
          )}

          {appointment.notes && (
            <p className="mt-2 text-xs text-ink-muted italic">{appointment.notes}</p>
          )}
        </div>

        <div className="text-right">
          {/* A rental booking's `price` is the CLIENT's, which Melanite no longer knows and the
              database forces to zero — so showing it reads as "this session was free" for one
              the provider was charged $60 for. The rent is the only money on the booking. */}
          {appointment.paymentSource === 'rental' ? (
            appointment.paidFromCredit ? (
              <>
                <div className="text-lg font-semibold tabular-nums">$0.00</div>
                <div className="text-xs text-ink-faint">credited session</div>
              </>
            ) : unsettled ? (
              /* NOT "$0.00 — no rent recorded". That was the alarm for a session that used the
                 laser and was never billed, and it was correct while the fee was taken at the
                 moment of booking. Rent is now swept twelve hours after the session ends, so
                 every booking looks exactly like that for its first half-day — and a provider
                 reading "$0.00, no rent recorded" on a session they are about to be charged
                 $95 for would reasonably conclude it was free. */
              <>
                <div className="text-lg font-semibold tabular-nums text-ink-secondary">
                  {dueCents === null ? '—' : usd(dueCents / 100)}
                </div>
                <div className="text-xs text-ink-faint">
                  {/* "no fee set" is a GAP — a service Melanite prices and has not. For the
                      three it is the permanent, correct state, and reading it as a gap would
                      have them chasing a price nobody is going to publish. */}
                  {keoniSetsFee
                    ? 'Keoni sets this'
                    : dueCents === null
                      ? 'no fee set'
                      : 'rent due'}
                </div>
              </>
            ) : (
              <>
                <div className="text-lg font-semibold tabular-nums">
                  {usd((appointment.rentalCents ?? 0) / 100)}
                </div>
                <div className="text-xs text-ink-faint">
                  {appointment.rentalCents === 0 ? 'rent refunded' : 'rent'}
                </div>
              </>
            )
          ) : (
            <div className="text-lg font-semibold tabular-nums">{usd(appointment.price)}</div>
          )}
          {discounted && (
            <>
              <div className="text-xs text-ink-faint tabular-nums line-through">
                {usd(appointment.originalPrice)}
              </div>
              <div className="text-xs text-ink-faint tabular-nums">
                {appointment.discountType === 'percent'
                  ? `${Number(appointment.discountValue)}% off`
                  : `${usd(appointment.discountValue)} off`}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-4">
        <AppointmentActions
          appointment={appointment}
          lateCancellationHours={lateCancellationHours}
        />
        {appointment.checkoutToken && appointment.checkoutStatus && appointment.checkoutExpiresAt && (
          <PaymentLink
            bookingId={appointment.id}
            url={`${origin}/pay/${appointment.checkoutToken}`}
            status={appointment.checkoutStatus}
            expiresAt={appointment.checkoutExpiresAt}
            hasEmail={Boolean(appointment.clientEmail)}
          />
        )}
        {/* TWO PEER ACTIONS on a finished session: how you left the room, and what you
            charged. Side by side rather than one inside the other, because they are different
            jobs with different audiences — the close-out is a safety record about a shared
            machine, the figure is billing. Nesting them is what briefly made signing the room
            off impossible without an invoice.
            Either can be absent. The close-out goes on a cancellation, a no-show, and twelve
            hours after any session; the receipt only ever appears for a RENTAL booking of a
            `keoni_sets` provider — their pre-cutover client appointments are still on this
            list and were settled at the point of sale, so asking there would invite somebody
            to pay twice. */}
        {/* The divider belongs to the ROW, not to each action, or two peers side by side draw
            two rules. An empty row draws none, which is what a cancelled session should get. */}
        {(closeoutOffered || receiptOffered) && (
          <SessionActions
            bookingId={appointment.id}
            closeoutOffered={closeoutOffered}
            recorded={appointment.closeout}
            receiptOffered={receiptOffered}
            sentAmountCents={appointment.receiptAmountCents}
            sentAt={appointment.receiptUploadedAt?.toISOString() ?? null}
            late={!closeoutWindowOpen(appointment)}
          />
        )}
      </div>
    </li>
  )
}



async function AppointmentList({
  providerId,
  status,
  month,
  service,
}: {
  providerId: string
  status?: AppointmentStatus
  month?: string
  service?: string
}) {
  // Resolved once per list rather than per card — it reads request headers, and a card is not
  // the place to be doing that.
  const origin = await appOrigin()
  const appointments = await getAppointments(providerId, {
    status,
    month,
    providerServiceId: service,
  })

  if (appointments.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line p-10 text-center">
        <p className="text-sm text-ink-muted">No appointments match these filters.</p>
      </div>
    )
  }

  // The live schedule, loaded ONCE and mapped in code rather than queried per row — the same
  // trick `app/app/book/page.tsx` uses for its dropdown, and for the same reason: a provider
  // with a month of appointments would otherwise be a round trip each.
  const [schedule, settings, promotions, [me]] = await Promise.all([
    getLiveSchedule(),
    getCheckoutSettings(),
    // Everything these sessions might still be OWED, which is not the same as everything
    // running: one Keoni ended early still owes its price to every session booked before she
    // ended it, and those are exactly the rows in this list. See `promotionsOwed`.
    promotionsOwed(),
    // Once per list, not once per card. Which basis they are on decides whether every finished
    // session asks them for a receipt, and it is the same answer for every row.
    db
      .select({ rentBasis: providers.rentBasis })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1),
  ])
  const keoniSetsFee = me?.rentBasis === 'keoni_sets'
  /** What this session will cost, on the day it happens, at the price it was booked at.
   *
   *  ON ITS OWN DATE, not today: a provider looking at next month's bookings during a
   *  promotion that ends this week must not be quoted this week's price for them.
   *
   *  AND AT ITS OWN BOOKING DATE, so this page agrees with the card. A promotion Keoni ended
   *  early keeps applying to sessions booked before she ended it; showing the full fee here
   *  would contradict the charge that is actually coming. */
  const feeFor = (serviceName: string, on: Date, bookedAt: Date): number | null => {
    const tier = tierForService(serviceName)
    if (!tier) return null
    const listed = schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents
    return discountedCents(listed, promotionFor(tier.key, denverYmd(on), promotions, bookedAt))
  }

  return (
    <ul className="space-y-3">
      {appointments.map((a) => (
        <AppointmentCard
          key={a.id}
          appointment={a}
          origin={origin}
          dueCents={keoniSetsFee ? null : feeFor(a.serviceName, a.startTime, a.bookedAt)}
          lateCancellationHours={settings.lateCancellationHours}
          keoniSetsFee={keoniSetsFee}
        />
      ))}
    </ul>
  )
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    month?: string
    service?: string
    booked?: string
    emailed?: string
  }>
}) {
  const user = await requireProvider()
  const params = await searchParams

  const validStatuses = new Set<AppointmentStatus>([
    'upcoming',
    'completed',
    'cancelled',
    'no_show',
  ])
  // Anything unrecognised is ignored rather than passed to the query — a hand-edited URL
  // should narrow nothing, not error.
  const status = validStatuses.has(params.status as AppointmentStatus)
    ? (params.status as AppointmentStatus)
    : undefined
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month : undefined

  const [counts, months, serviceOptions] = await Promise.all([
    getAppointmentCounts(user.id),
    getBookedMonths(user.id),
    getProviderServiceOptions(user.id),
  ])

  // Only after a booking, and only for a booking that belongs to this provider.
  const justBooked = params.booked
    ? await getRentalBookingSummary(params.booked, user.id)
    : null

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {counts.total} total · {counts.upcoming} upcoming
        </p>
      </header>

      {justBooked && (
        <RentalBookedBanner
          serviceName={justBooked.serviceName}
          when={justBooked.startTime.toLocaleString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'America/Denver',
          })}
          chargedCents={justBooked.chargedCents}
          packSession={justBooked.packSession}
          sharesRevenue={sharesRevenue(user.revenueModel)}
        />
      )}

      <Filters months={months} serviceOptions={serviceOptions} counts={counts} />

      {/* Keyed so switching filters shows the fallback rather than stale rows. */}
      <Suspense
        key={`${status ?? ''}-${month ?? ''}-${params.service ?? ''}`}
        fallback={<div className="p-10 text-center text-sm text-ink-faint">Loading…</div>}
      >
        <AppointmentList
          providerId={user.id}
          status={status}
          month={month}
          service={params.service}
        />
      </Suspense>
    </main>
  )
}
