import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { REQUIRED_ITEM_COUNT } from '@/lib/end-of-use'
import { equipmentPhotoUrl } from '@/lib/blob'

import { RemovePhoto } from './remove-photo'
import {
  getCloseoutIssues,
  getConditionalItemCounts,
  getRecentCloseouts,
  getSessionsWithoutCloseout,
} from '@/lib/db/queries/end-of-use'

export const metadata: Metadata = { title: 'Equipment & close-outs · Melanite' }
export const dynamic = 'force-dynamic'

// What providers reported about the laser, and the sessions nobody accounted for.
//
// Exceptions first, deliberately. A wall of thumbnails where everything is fine is a page that
// gets opened twice and then never again.
//
// This used to lead with photographs, because every session was bracketed by one on arrival and
// the GAP was the signal — a session with no photo was damage that could not be pinned to anybody.
// Keoni dropped the brackets on 2026-09-17: two prompts an appointment for a machine almost always
// fine. A photograph now appears only against a reported fault, so the thing worth leading with is
// the report itself.
//
// Everything here is derived from the bookings and close-outs themselves, never a stored work
// list, so nothing can linger after it has been dealt with — the rule the review queue follows.

const when = (d: Date) =>
  d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

/** "today" / "yesterday" / "3 days ago", never "0d ago".
 *
 *  Follows `admin/queue`, which already says "since today" rather than a zero. A session from
 *  last night rendering as "0d ago" reads as a bug on a page whose entire job is to be trusted at
 *  a glance — and this list is the one Keoni is meant to act on. */
function agoLabel(d: Date): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function Photo({
  checkId,
  alt,
  deletedAt,
}: {
  checkId: string
  alt: string
  deletedAt?: Date | null
}) {
  // A removed photograph is shown as removed rather than omitted. An empty space where an image
  // used to be reads as a bug; saying it was deleted, and that the check still counts, is the
  // whole reason the row outlives the file.
  if (deletedAt) {
    return (
      <div className="flex size-24 shrink-0 flex-col items-center justify-center gap-1 rounded-field border border-dashed border-line px-2 text-center">
        <span className="text-[10px] leading-tight text-ink-faint">Photo removed</span>
        <span className="text-[10px] leading-tight text-ink-disabled">{when(deletedAt)}</span>
      </div>
    )
  }

  // A plain <img>, not next/image. Running these through the optimiser would mean adding a
  // remote pattern for the blob host and caching optimised copies of operational photographs in
  // a second place — more surface for images whose whole point is that they live in exactly one
  // known location. They are thumbnails of a machine; the LCP argument does not apply.
  return (
    <a href={equipmentPhotoUrl(checkId)} target="_blank" rel="noreferrer" className="shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={equipmentPhotoUrl(checkId)}
        alt={alt}
        loading="lazy"
        className="size-24 rounded-field border border-line object-cover"
      />
    </a>
  )
}

export default async function EquipmentPage() {
  await requireAdmin()

  const [closeoutIssues, unclosed, cameUp, recentCloseouts] = await Promise.all([
    getCloseoutIssues(),
    getSessionsWithoutCloseout(),
    getConditionalItemCounts(),
    getRecentCloseouts(),
  ])

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Equipment &amp; close-outs</h1>
        <p className="mt-1 text-sm text-ink-muted">
          How providers said they left the room, and anything they reported wrong with the laser.
          Problems and unaccounted sessions first.
        </p>
      </header>



      {closeoutIssues.length > 0 && (
        <section className="rounded-card border border-critical/40 bg-critical/10 p-5">
          <h2 className="text-sm font-medium">
            {closeoutIssues.length}{' '}
            {closeoutIssues.length === 1 ? 'device issue' : 'device issues'} reported on a close-out
          </h2>
          <p className="mt-1 text-xs text-ink-secondary">
            Each one carries the photograph the provider had to attach.
          </p>
          <ul className="mt-3 space-y-2">
            {closeoutIssues.map((c) => (
              <li key={c.id} className="flex gap-3 rounded-card border border-line bg-surface p-3">
                <Photo
                  checkId={c.id}
                  alt={`Laser, reported by ${c.providerName}`}
                  deletedAt={c.photoDeletedAt}
                />
                <div className="min-w-0">
                <p className="text-sm font-medium">{c.providerName}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {c.serviceName} · {when(c.startTime)}
                </p>
                <p className="mt-1.5 text-sm text-ink-secondary italic">“{c.deviceIssueNote}”</p>
                {/* NOT "21 of 25". The twenty required items are ticked on anything that can be
                    stored, so a raw count reads as four things missed when nothing was — the same
                    reason the evening digest stopped printing one. What is worth saying is how
                    many of the five conditionals actually came up. */}
                <p className="mt-1 text-xs text-ink-faint">
                  {c.itemsDone > REQUIRED_ITEM_COUNT
                    ? `All required, plus ${c.itemsDone - REQUIRED_ITEM_COUNT} reported`
                    : 'All required items ticked'}
                </p>
                {!c.photoDeletedAt && <RemovePhoto checklistId={c.id} />}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unclosed.length > 0 && (
        <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
          <h2 className="text-sm font-medium">
            {unclosed.length} {unclosed.length === 1 ? 'session' : 'sessions'} left without a
            close-out
          </h2>
          <p className="mt-1 text-xs text-ink-secondary">
            The laser was used and nobody said how they left the room. This cannot be filled in
            now — a check-off today would describe a room other people have used since. It is a
            record, not a task.
          </p>
          <ul className="mt-3 space-y-2">
            {unclosed.map((s) => (
              <li
                key={s.bookingId}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-card border border-line bg-surface px-3 py-2"
              >
                <span className="text-sm">{s.providerName}</span>
                <span className="text-xs text-ink-muted">
                  {s.serviceName} · {when(s.startTime)}
                </span>
                <span className="text-xs text-ink-faint tabular-nums">
                  {agoLabel(s.startTime)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closeoutIssues.length === 0 && unclosed.length === 0 && (
        <div className="rounded-card border border-dashed border-line p-8 text-center">
          <p className="text-sm text-ink-muted">
            Nothing reported, and every session was closed out.
          </p>
        </div>
      )}

      {/* Quiet, and not an exceptions block at all. Every required item is ticked on every stored
          close-out, so the only thing worth totalling is how often the conditional ones CAME UP —
          a shortage, damage, an adverse event. That is a fact about the month rather than about a
          person, and it is what the paper form could never add up. */}
      {cameUp.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
            What came up
          </h2>
          <ul className="space-y-1">
            {cameUp.slice(0, 5).map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline justify-between gap-x-4 rounded-card border border-line px-3 py-2"
              >
                <span className="text-xs text-ink-secondary">{item.label}</span>
                <span className="text-xs text-ink-faint tabular-nums">
                  {item.times}&times;
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Recent close-outs
        </h2>

        {recentCloseouts.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center">
            <p className="text-sm text-ink-muted">Nobody has closed out a session yet.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {recentCloseouts.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-card border border-line bg-surface px-3 py-2"
              >
                <span className="text-sm">{c.providerName}</span>
                <span className="text-xs text-ink-muted">
                  {c.serviceName} · {when(c.startTime)}
                </span>
                <span className="text-xs text-ink-faint tabular-nums">
                  {c.itemsDone} of {c.itemCount}
                  {c.deviceIssue && ' · issue reported'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* "who had it" was the chain of custody, and that is the thing dropping the before/after
          brackets gave up. Saying it here would promise an answer this page can no longer give. */}
      <p className="text-xs text-ink-faint">
        Photographs are taken by providers on their phones and timestamped when Melanite receives
        them, not by the camera. Nothing here stops the laser being used — it records what somebody
        said they did, and anything they reported wrong.
      </p>
    </main>
  )
}
