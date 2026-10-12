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

import { AppointmentActions } from './appointment-actions'
import { closeoutWindowOpen } from '@/lib/end-of-use'
import { tierForService } from '@/lib/rental-fees'
import { sharesRevenue } from '@/lib/revenue-model'
import { getCheckoutSettings } from '@/lib/db/queries/checkout'
import { getLiveSchedule } from '@/lib/rental/schedule'

import { EndOfUseChecklist } from './end-of-use-checklist'
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
}: {
  appointment: Appointment
  origin: string
  /** From `platform_settings`. Cancelling with more notice than this asks for no reason, and
   *  nothing is owed — Keoni's rule of 12 October. */
  lateCancellationHours: number
  /** What this session WILL cost, for one that has not been swept yet. Null when the service
   *  has no published fee. */
  dueCents: number | null
}) {
  const discounted = appointment.discountType !== 'none' && Number(appointment.discountValue) > 0

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
                  {dueCents === null ? 'no fee set' : 'rent due'}
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
        <CloseoutPrompt appointment={appointment} />
      </div>
    </li>
  )
}

/** The close-out prompt, on a finished session.
 *
 *  This used to render three things: a photograph on arrival, a second one on the way out when
 *  nobody followed closely enough to bracket the session, and the checklist. Keoni dropped the
 *  brackets on 2026-09-17 — two prompts an appointment for a machine that was almost always fine —
 *  in favour of one photograph attached to an actual report, which the checklist now collects.
 *
 *  Only on a session that has finished and is still inside its window. A prompt on an appointment
 *  three weeks out is noise, and one from last month cannot be answered truthfully any more.
 *  Cancelled and no-show bookings never touched the machine, so they get nothing. */
function CloseoutPrompt({ appointment }: { appointment: Appointment }) {
  if (appointment.status === 'cancelled' || appointment.status === 'no_show') return null
  if (appointment.endTime > new Date()) return null
  if (!closeoutWindowOpen(appointment)) return null

  return (
    <div className="mt-3 border-t border-line pt-3">
      <EndOfUseChecklist bookingId={appointment.id} recorded={appointment.closeout} />
    </div>
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
  const [schedule, settings] = await Promise.all([getLiveSchedule(), getCheckoutSettings()])
  const feeFor = (serviceName: string): number | null => {
    const tier = tierForService(serviceName)
    if (!tier) return null
    return schedule.byTier.get(tier.key)?.singleCents ?? tier.singleCents
  }

  return (
    <ul className="space-y-3">
      {appointments.map((a) => (
        <AppointmentCard
          key={a.id}
          appointment={a}
          origin={origin}
          dueCents={feeFor(a.serviceName)}
          lateCancellationHours={settings.lateCancellationHours}
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
