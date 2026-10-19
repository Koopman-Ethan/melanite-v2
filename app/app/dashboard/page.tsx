import type { Metadata } from 'next'
import Link from 'next/link'

import { BookingGates } from '@/components/booking-gates'
import { bookingBlockedReasons, canBook, requireProvider } from '@/lib/auth/dal'
import { getAppointmentCounts, getNextAppointment } from '@/lib/db/queries/appointments'
import { getChargeTotals } from '@/lib/db/queries/charges'
import { packBalancesFor } from '@/lib/rental/packs'

export const metadata: Metadata = { title: 'Dashboard · Melanite' }
export const dynamic = 'force-dynamic'

const usd = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const DENVER = 'America/Denver'

const when = (d: Date) => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: DENVER }).format(d)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: DENVER }).format(new Date())
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DENVER,
  })

  if (day === today) return `Today at ${time}`
  const date = d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: DENVER,
  })
  return `${date} at ${time}`
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-ink-faint">{sub}</div>
    </div>
  )
}

export default async function DashboardPage() {
  const user = await requireProvider()
  const gates = bookingBlockedReasons(user)
  const cleared = canBook(user)

  // Only queried once the provider is actually cleared. Someone still in setup has no
  // appointments and no earnings, and four zeroes read as a broken page rather than an empty
  // one — the gates above are the answer they need.
  const [next, counts, charges, packs] = cleared
    ? await Promise.all([
        getNextAppointment(user.id),
        getAppointmentCounts(user.id),
        getChargeTotals(user.id),
        packBalancesFor(user.id),
      ])
    : [null, null, null, []]

  const packSessionsLeft = packs.reduce((n, p) => n + p.sessionsRemaining, 0)

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Welcome back, {user.firstName}</h1>
        <p className="mt-1 text-sm text-ink-muted">Your practice at a glance</p>
      </header>

      {/* Every failing gate, stated plainly. v1 enforced these across page JS and
          per-endpoint checks with no single place that said why a provider was blocked, so
          the answer was usually a support message rather than something on screen. */}
      <BookingGates gates={gates} heading="Booking is not available yet" />

      {cleared && counts && charges && (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              Next appointment
            </h2>
            {next ? (
              <Link
                href="/app/appointments"
                className="block rounded-card border border-line bg-surface p-5 hover:border-line-strong"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <div className="font-medium">{next.clientName}</div>
                    <div className="mt-0.5 text-sm text-ink-muted">{next.serviceName}</div>
                  </div>
                  <div className="text-sm text-gold">{when(next.startTime)}</div>
                </div>
              </Link>
            ) : (
              <div className="rounded-card border border-dashed border-line p-8 text-center">
                <p className="text-sm text-ink-muted">Nothing booked yet.</p>
                <Link href="/app/book" className="mt-1 inline-block text-sm text-gold">
                  Book laser time →
                </Link>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
              This month
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* What this app can honestly tell a provider about their month. It used to
                  lead with what they earned; under the rental model Melanite does not know
                  that — they bill their own clients — so showing an earnings figure would
                  mean showing a wrong one. What it does know is what it charged them. */}
              <Stat
                label="Upcoming"
                value={String(counts.upcoming)}
                sub={counts.upcoming === 1 ? 'appointment' : 'appointments'}
              />
              <Stat
                label="Laser rental"
                value={usd(charges.rentalMonth)}
                sub={`${charges.sessionsMonth} ${charges.sessionsMonth === 1 ? 'session' : 'sessions'} this month`}
              />
              <Stat
                label="Pack sessions left"
                value={String(packSessionsLeft)}
                sub={packSessionsLeft > 0 ? 'already paid for' : 'no packs'}
              />
              <Stat
                label="Paid Melanite"
                value={usd(charges.allMonth)}
                sub="this month, everything"
              />
            </div>
          </section>

        </>
      )}
    </main>
  )
}
