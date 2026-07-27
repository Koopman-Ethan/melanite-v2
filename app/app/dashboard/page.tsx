import type { Metadata } from 'next'

import { BookingGates } from '@/components/booking-gates'
import { bookingBlockedReasons, canBook, requireProvider } from '@/lib/auth/dal'

export const metadata: Metadata = { title: 'Dashboard · Melanite' }
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const user = await requireProvider()
  const gates = bookingBlockedReasons(user)

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

      {canBook(user) && (
        <div className="rounded-card border border-line bg-surface p-6">
          <p className="text-sm text-ink-muted">
            You&rsquo;re cleared to book. Appointments, earnings and packages are not built yet.
          </p>
        </div>
      )}
    </main>
  )
}
