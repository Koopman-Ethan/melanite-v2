import type { Metadata } from 'next'
import Link from 'next/link'

import { BookingGates } from '@/components/booking-gates'
import { bookingBlockedReasons, canBook, requireProvider } from '@/lib/auth/dal'
import { getAppointmentCounts, getNextAppointment } from '@/lib/db/queries/appointments'
import { getCheckPrompts } from '@/lib/db/queries/equipment'
import { getEarningsTotals } from '@/lib/db/queries/earnings'
import { getOutstandingPackageLinks } from '@/lib/db/queries/packages'

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
  const [next, counts, earnings, links, prompts] = cleared
    ? await Promise.all([
        getNextAppointment(user.id),
        getAppointmentCounts(user.id),
        getEarningsTotals(user.id),
        getOutstandingPackageLinks(user.id),
        getCheckPrompts(user.id),
      ])
    : [null, null, null, [], []]

  // Only what is still outstanding, and only the "after" when nobody follows — otherwise the
  // next provider's arrival photo already records how this session left the machine, and asking
  // is friction that buys nothing.
  const checkPrompts = prompts.filter((p) =>
    p.hasBefore ? p.afterNeeded && !p.hasAfter : true,
  )

  const cherry = links.filter((l) => l.cherryStartedAt)

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

      {cleared && counts && earnings && (
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
              {/* Earned and prepaid stay apart, for the reason the earnings page exists to
                  preserve: package money arrives before the work does, so adding the two
                  would overstate what has actually been earned. */}
              <Stat
                label="Earned"
                value={usd(earnings.earnedMonth)}
                sub="work delivered"
              />
              <Stat
                label="Awaiting payout"
                value={usd(earnings.pendingPayout)}
                sub="not yet sent to your bank"
              />
              <Stat
                label="Package sales"
                value={usd(earnings.prepaidMonth)}
                sub="paid up front"
              />
              <Stat
                label="Upcoming"
                value={String(counts.upcoming)}
                sub={counts.upcoming === 1 ? 'appointment' : 'appointments'}
              />
            </div>
          </section>

          {/* Only shown when there is something to act on. A permanent empty panel teaches
              people to stop looking at that part of the screen. */}
          {(links.length > 0 || checkPrompts.length > 0) && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
                Needs your attention
              </h2>

              {/* The laser, if they are working today. First in the panel because it is the one
                  thing here that expires: an arrival photo taken tomorrow records nothing, and
                  a package link will still be there this evening. */}
              {checkPrompts.map((p) => (
                <Link
                  key={p.bookingId}
                  href="/app/appointments"
                  className="block rounded-card border border-gold/40 bg-gold/5 p-5 hover:border-gold/60"
                >
                  <div className="font-medium">
                    {p.hasBefore
                      ? 'Photograph the laser before you leave'
                      : 'Photograph the laser before you start'}
                  </div>
                  <div className="mt-0.5 text-sm text-ink-muted">
                    {p.clientName} · {p.serviceName}
                    {p.hasBefore
                      ? ' — nobody is booked after you, so nothing else will record how you left it.'
                      : ' — it is your record that you found it the way you found it.'}
                  </div>
                </Link>
              ))}

              {links.length > 0 && (
              <Link
                href="/app/packages"
                className="block rounded-card border border-gold/40 bg-gold/5 p-5 hover:border-gold/60"
              >
                <div className="font-medium">
                  {links.length} package {links.length === 1 ? 'link' : 'links'} awaiting payment
                </div>
                <div className="mt-0.5 text-sm text-ink-muted">
                  {cherry.length > 0
                    ? `${cherry.length} applied through Cherry — Melanite collects those and pays you your half.`
                    : 'Sent, and nobody has paid yet.'}
                </div>
              </Link>
              )}
            </section>
          )}
        </>
      )}
    </main>
  )
}
