import Link from 'next/link'

import { equipmentPhotoUrl } from '@/lib/blob'
import type { CloseoutRecord } from '@/lib/db/queries/end-of-use'

// Pieces the equipment page and a single close-out's page both draw.

export const when = (d: Date) =>
  d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Denver',
  })

export function Photo({
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

export const closeoutHref = (id: string) => `/app/admin/equipment/${id}`

/** One close-out as a line in a list, opening its own page. */
export function CloseoutRow({ closeout: c }: { closeout: CloseoutRecord }) {
  return (
    <li>
      <Link
        href={closeoutHref(c.id)}
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-card border border-line bg-surface px-3 py-2 hover:border-line-strong"
      >
        <span className="text-sm">{c.providerName}</span>
        <span className="text-xs text-ink-muted">
          {c.serviceName} · {when(c.startTime)}
        </span>
        <span className="text-xs text-ink-faint tabular-nums">
          {c.itemsDone} of {c.itemCount}
          {c.deviceIssue && ' · issue reported'}
        </span>
      </Link>
    </li>
  )
}
