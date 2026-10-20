import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/lib/auth/dal'
import { getProcessingRate } from '@/lib/db/queries/admin-tools'
import { activePromotions } from '@/lib/rental/promotions'
import { getLiveSchedule, providersNeedingReacceptance } from '@/lib/rental/schedule'
import { todayInDenver } from '@/lib/validation'

import { PricingForm } from './form'
import { Promotions } from './promotions'

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

  const [schedule, awaiting, promotions, processing] = await Promise.all([
    getLiveSchedule(),
    providersNeedingReacceptance(),
    activePromotions(),
    getProcessingRate(),
  ])

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Laser pricing</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What Melanite <strong className="text-ink-secondary">keeps</strong> from one session.
          Card processing is added on top, so the figure a provider is charged is a little
          higher than the one here. What they charge their own client is theirs to decide —
          these figures never reach a client.
        </p>
        {/* Said on the screen rather than only in a runbook, because the difference between the
            schedule and a provider's statement is the first thing somebody queries and the
            answer is not guessable from this page alone. The three on `keoni_sets` are not
            priced here at all — Keoni sets each of their sessions from a receipt. */}
        <p className="mt-2 text-xs text-ink-faint">
          Leyla, Brittany and Karly are not on this schedule. They send a receipt for each
          session and you set what they owe from{' '}
          <Link href="/app/admin/queue" className="underline underline-offset-4 hover:text-ink">
            the queue
          </Link>
          .
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
        promotions={promotions}
        today={todayInDenver()}
      />

      <Promotions
        running={promotions}
        entries={schedule.entries}
        today={todayInDenver()}
        processing={processing}
      />
    </main>
  )
}
