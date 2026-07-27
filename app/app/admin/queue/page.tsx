import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { getReviewQueue, getTransferTargets } from '@/lib/db/queries/review-queue'

import { QueueRow } from './queue-item'

export const metadata: Metadata = { title: 'Queue · Melanite Admin' }
export const dynamic = 'force-dynamic'

const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const todayInDenver = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())

export default async function AdminQueuePage() {
  await requireAdmin()

  const [queue, transferTargets] = await Promise.all([
    getReviewQueue(),
    getTransferTargets(todayInDenver()),
  ])

  const atStake = queue.reduce((sum, item) => sum + Number(item.amount), 0)
  const oldestDays = queue[0]?.waitingDays ?? 0

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Queue</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Money the system deliberately stopped short of deciding about.
        </p>
      </header>

      {queue.length === 0 ? (
        <div className="rounded-card border border-dashed border-line p-10 text-center">
          <p className="text-sm text-ink-muted">Nothing waiting.</p>
          <p className="mt-1 text-xs text-ink-faint">
            Late room cancellations, fees that failed to charge, and deposits on cancelled
            courses all land here.
          </p>
        </div>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-card border border-line p-4">
              <div className="text-xs uppercase tracking-wide text-ink-muted">Waiting</div>
              <div className="mt-1.5 text-2xl font-semibold tabular-nums">{queue.length}</div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {usd(atStake)} at stake
              </div>
            </div>
            <div className="rounded-card border border-line p-4">
              <div className="text-xs uppercase tracking-wide text-ink-muted">Oldest</div>
              <div className="mt-1.5 text-2xl font-semibold tabular-nums">
                {oldestDays === 0 ? 'Today' : `${oldestDays}d`}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {oldestDays >= 7 ? 'someone is still waiting on this' : 'nothing stale yet'}
              </div>
            </div>
          </section>

          {/* Oldest first. Age is what matters in a queue — the thing waiting longest is the
              thing most likely to have been forgotten about. */}
          <ul className="space-y-3">
            {queue.map((item) => (
              <QueueRow
                key={`${item.kind}:${item.id}`}
                item={{ ...item, since: item.since.toISOString() }}
                transferTargets={transferTargets}
              />
            ))}
          </ul>
        </>
      )}

      <p className="text-xs text-ink-faint">
        Every item here is derived from the state of the thing itself, not from a separate list
        — so nothing can linger after it has been dealt with, and nothing can be dealt with
        without leaving the queue.
      </p>
    </main>
  )
}
