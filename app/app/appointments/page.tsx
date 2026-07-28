import type { Metadata } from 'next'
import { Suspense } from 'react'

import { requireProvider } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import {
  getAppointmentCounts,
  getAppointments,
  getBookedMonths,
  getBookingLink,
  getProviderServiceOptions,
  type Appointment,
  type AppointmentStatus,
} from '@/lib/db/queries/appointments'
import { appOrigin } from '@/lib/stripe/config'

import { AppointmentActions } from './appointment-actions'
import { BookedBanner } from './booked-banner'
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
  comped: 'Comped',
}

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

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

function AppointmentCard({ appointment }: { appointment: Appointment }) {
  const discounted = appointment.discountType !== 'none' && Number(appointment.discountValue) > 0

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
          <div className="text-lg font-semibold tabular-nums">{usd(appointment.price)}</div>
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
        <AppointmentActions appointment={appointment} />
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

  return (
    <ul className="space-y-3">
      {appointments.map((a) => (
        <AppointmentCard key={a.id} appointment={a} />
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
  const justBooked = params.booked ? await getBookingLink(params.booked, user.id) : null

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {counts.total} total · {counts.upcoming} upcoming
        </p>
      </header>

      {justBooked && (
        <BookedBanner
          url={`${await appOrigin()}/pay/${justBooked.token}`}
          clientName={justBooked.clientName}
          clientEmail={justBooked.clientEmail}
          emailed={params.emailed === '1'}
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
