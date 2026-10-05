import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { getLiveSchedule, providersNeedingReacceptance } from '@/lib/rental/schedule'

import { PricingForm } from './form'

export const metadata: Metadata = { title: 'Laser pricing · Melanite' }
export const dynamic = 'force-dynamic'

/** What Melanite charges providers to use the laser.
 *
 *  The one number in this platform that somebody changes regularly and that a provider has
 *  agreed to. Both halves of that shape the page: it is editable without a deploy, and
 *  publishing a change asks every provider to accept it before they book again.
 */
export default async function PricingPage() {
  await requireAdmin()

  const [schedule, awaiting] = await Promise.all([
    getLiveSchedule(),
    providersNeedingReacceptance(),
  ])

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Laser pricing</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What a provider pays Melanite for one session. What they charge their own client is
          theirs to decide — these figures never reach a client.
        </p>
      </header>

      <PricingForm
        version={schedule.version}
        publishedAt={
          schedule.publishedAt
            ? schedule.publishedAt.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
                timeZone: 'America/Denver',
              })
            : null
        }
        note={schedule.note}
        entries={schedule.entries}
        awaitingAcceptance={awaiting}
      />
    </main>
  )
}
