import type { Metadata } from 'next'

import { requireOversight } from '@/lib/auth/dal'
import {
  OVERSIGHT_DAYS,
  getOverseenProviders,
  getUpcomingSchedule,
  type OverseenProvider,
} from '@/lib/db/queries/oversight'
import { licenseStatus, licenseUrgency } from '@/lib/license'

export const metadata: Metadata = { title: 'Oversight · Melanite' }
export const dynamic = 'force-dynamic'

const dayLabel = (d: Date) =>
  d.toLocaleDateString('en-US', {
    weekday: 'long',
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

/** Denver calendar day, for grouping. Assembled from parts rather than by slicing a locale
 *  string — an en-US format with a year and no month renders as "Jun 14 – 2026". */
function denverDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(d)
}

function CredentialLine({ provider }: { provider: OverseenProvider }) {
  const licence = licenseStatus(provider.licenseExpiry)
  const wording =
    licence.state === 'missing'
      ? 'no licence on file'
      : licence.state === 'expired'
        ? `licence expired ${provider.licenseExpiry}`
        : licence.state === 'expiring'
          ? `licence expires in ${licence.daysLeft} days (${provider.licenseExpiry})`
          : `licence valid to ${provider.licenseExpiry}`

  return (
    <span className="text-xs">
      <span className={licence.state === 'ok' ? 'text-success' : 'text-warning'} aria-hidden>
        {licence.state === 'ok' ? '✓' : '!'}
      </span>{' '}
      <span className="text-ink-secondary">
        {provider.licenseNumber ?? '—'}
        {provider.licenseState && ` · ${provider.licenseState}`}
      </span>
      <span className="text-ink-muted"> · {wording}</span>
    </span>
  )
}

export default async function OversightPage() {
  const user = await requireOversight()

  const [providers, schedule] = await Promise.all([
    getOverseenProviders(),
    getUpcomingSchedule(),
  ])

  // Credentials that need chasing, surfaced above everything else. A lapsed licence is the one
  // thing on this page that is his problem to act on rather than to observe.
  const attention = providers
    .map((provider) => ({ provider, status: licenseStatus(provider.licenseExpiry) }))
    .filter(({ status }) => status.state !== 'ok')
    .sort((a, b) => licenseUrgency(a.status) - licenseUrgency(b.status))

  const byDay = new Map<string, typeof schedule>()
  for (const item of schedule) {
    const key = denverDay(item.startTime)
    byDay.set(key, [...(byDay.get(key) ?? []), item])
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Oversight</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The providers practising under your medical direction, what they are credentialed to
          perform, and what is scheduled over the next {OVERSIGHT_DAYS} days.
        </p>
      </header>

      {attention.length > 0 && (
        <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
          <h2 className="text-sm font-medium text-warning">
            {attention.length === 1
              ? '1 credential needs attention'
              : `${attention.length} credentials need attention`}
          </h2>
          <ul className="mt-3 space-y-1.5">
            {attention.map(({ provider, status }) => (
              <li key={provider.id} className="text-sm">
                {provider.name}
                <span className="ml-2 text-xs text-ink-secondary">
                  {status.state === 'missing'
                    ? 'no expiry date on file'
                    : status.state === 'expired'
                      ? `expired ${provider.licenseExpiry} — booking blocked`
                      : `expires in ${status.daysLeft} days`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Under your direction ({providers.length})
        </h2>

        {providers.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            No providers are currently on Melanite&rsquo;s medical director plan.
          </p>
        ) : (
          <ul className="space-y-3">
            {providers.map((provider) => (
              <li key={provider.id} className="rounded-card border border-line p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  {!provider.bookingEnabled && (
                    <span className="text-xs text-ink-muted">not currently booking</span>
                  )}
                </div>

                <div className="mt-1.5">
                  <CredentialLine provider={provider} />
                </div>

                {/* The clinical scope — what he is actually signing off on. */}
                <div className="mt-3 border-t border-line pt-2">
                  <span className="text-xs uppercase tracking-wide text-ink-faint">
                    Performs
                  </span>
                  {provider.services.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-muted">
                      No services configured — they cannot take a booking.
                    </p>
                  ) : (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {provider.services.map((service) => (
                        <li
                          key={service.name}
                          className="rounded-field border border-line px-2 py-1 text-xs text-ink-secondary"
                        >
                          {service.name}
                          <span className="ml-1.5 text-ink-faint">{service.durationMins} min</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Next {OVERSIGHT_DAYS} days
        </h2>

        {schedule.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            Nothing scheduled in the next {OVERSIGHT_DAYS} days.
          </p>
        ) : (
          <div className="space-y-5">
            {[...byDay.entries()].map(([day, items]) => (
              <div key={day}>
                <h3 className="text-xs uppercase tracking-wide text-gold">
                  {dayLabel(items[0].startTime)}
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {items.map((item) => (
                    <li
                      key={`${item.kind}-${item.id}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border border-line p-3 text-sm"
                    >
                      <span className="tabular-nums text-ink-secondary">
                        {timeLabel(item.startTime)}–{timeLabel(item.endTime)}
                      </span>
                      {item.kind === 'appointment' ? (
                        <>
                          <span>{item.serviceName}</span>
                          <span className="text-ink-muted">{item.clientName}</span>
                          {item.treatmentArea && (
                            <span className="text-xs text-ink-faint">{item.treatmentArea}</span>
                          )}
                        </>
                      ) : (
                        // Said in words, not by a colour or an icon: nobody is being treated
                        // here, the room is simply taken.
                        <span className="text-ink-muted">
                          Room rental
                          {item.treatmentArea && ` — ${item.treatmentArea.replace(/_/g, ' ')} day`}
                          {' · no treatment scheduled'}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-ink-faint">{item.providerName}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-ink-faint">
        Signed in as {user.firstName} {user.lastName}. This view is read-only — enabling or
        suspending a provider goes through Melanite.
      </p>
    </main>
  )
}
