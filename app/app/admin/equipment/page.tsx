import type { Metadata } from 'next'

import { requireAdmin } from '@/lib/auth/dal'
import { equipmentPhotoUrl } from '@/lib/blob'

import { RemovePhoto } from './remove-photo'
import {
  getFlaggedChecks,
  getRecentChecks,
  getUnbracketedSessions,
} from '@/lib/db/queries/equipment'

export const metadata: Metadata = { title: 'Equipment · Melanite' }
export const dynamic = 'force-dynamic'

// The condition of the laser, and — more usefully — the sessions nobody can account for.
//
// Exceptions first, deliberately. A wall of thumbnails where everything is fine is a page that
// gets opened twice and then never again, and the whole value of this record is the GAP: a
// session with no arrival photograph is one where damage found afterwards cannot be pinned to
// anybody. Everything here is derived from the bookings themselves, never a stored list, so
// nothing can linger after it has been dealt with — the same rule the review queue follows.

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

  const [flagged, unbracketed, recent] = await Promise.all([
    getFlaggedChecks(),
    getUnbracketedSessions(),
    getRecentChecks(),
  ])

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Equipment</h1>
        <p className="mt-1 text-sm text-ink-muted">
          The laser, photographed by whoever had it. Problems and unaccounted sessions first.
        </p>
      </header>

      {flagged.length > 0 && (
        <section className="rounded-card border border-critical/40 bg-critical/10 p-5">
          <h2 className="text-sm font-medium">
            {flagged.length} {flagged.length === 1 ? 'problem' : 'problems'} reported
          </h2>
          <ul className="mt-3 space-y-3">
            {flagged.map((f) => (
              <li key={f.id} className="flex gap-3 rounded-card border border-line bg-surface p-3">
                <Photo
                  checkId={f.id}
                  alt={`Laser, reported by ${f.providerName}`}
                  deletedAt={f.photoDeletedAt}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.providerName}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {f.kind === 'before' ? 'On arrival' : 'On the way out'} · {when(f.recordedAt)}
                  </p>
                  {f.note ? (
                    <p className="mt-1.5 text-sm text-ink-secondary italic">“{f.note}”</p>
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-faint">
                      No note — the photo is the whole message.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unbracketed.length > 0 && (
        <section className="rounded-card border border-warning/40 bg-warning/10 p-5">
          <h2 className="text-sm font-medium">
            {unbracketed.length}{' '}
            {unbracketed.length === 1 ? 'session' : 'sessions'} with no arrival photo
          </h2>
          <p className="mt-1 text-xs text-ink-secondary">
            The laser was used and nobody recorded the state they found it in. This cannot be
            filled in now — a photo taken today would show a machine other people have used since.
            It is a record, not a task.
          </p>
          <ul className="mt-3 space-y-2">
            {unbracketed.map((s) => (
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
                  {s.hasAfter && ' · has a leaving photo'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {flagged.length === 0 && unbracketed.length === 0 && (
        <div className="rounded-card border border-dashed border-line p-8 text-center">
          <p className="text-sm text-ink-muted">
            Nothing reported, and every recent session was photographed on arrival.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Recently photographed
        </h2>

        {recent.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center">
            <p className="text-sm text-ink-muted">No photos of the laser yet.</p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {recent.map((c) => (
              <li key={c.id} className="flex gap-3 rounded-card border border-line bg-surface p-3">
                <Photo
                  checkId={c.id}
                  alt={`Laser, ${when(c.recordedAt)}`}
                  deletedAt={c.photoDeletedAt}
                />
                <div className="min-w-0">
                  <p className="text-sm">{c.providerName}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {c.kind === 'before' ? 'On arrival' : 'On the way out'} · {when(c.recordedAt)}
                  </p>
                  {c.note && (
                    <p className="mt-1 text-xs text-ink-secondary italic">“{c.note}”</p>
                  )}
                  {c.needsAttention && (
                    <p className="mt-1 text-xs text-critical">Flagged as a problem</p>
                  )}
                  {c.photoDeletedAt ? (
                    <p className="mt-1 text-xs text-ink-faint">
                      Photo removed by Melanite. The session is still accounted for.
                    </p>
                  ) : (
                    <div className="mt-1.5">
                      <RemovePhoto checkId={c.id} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-ink-faint">
        Photographs are taken by providers on their phones and timestamped when Melanite receives
        them, not by the camera. Nothing here stops the laser being used — it records who had it
        and what they found.
      </p>
    </main>
  )
}
