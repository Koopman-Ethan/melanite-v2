import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/lib/auth/dal'
import { getCloseout } from '@/lib/db/queries/end-of-use'

import { RemovePhoto } from '../remove-photo'
import { Photo, when } from '../shared'

export const metadata: Metadata = { title: 'Close-out · Melanite' }
export const dynamic = 'force-dynamic'

// One close-out, whole.
//
// The equipment page lists close-outs and counts what came up, but until 4 November nothing on it
// could be opened: Keoni could see "Supply shortage reported — 2×" and not who, when, or what they
// wrote. This is where every list on that page, and the close-out email, now points.

export default async function CloseoutPage({
  params,
}: {
  params: Promise<{ checklistId: string }>
}) {
  await requireAdmin()

  const { checklistId } = await params
  const c = await getCloseout(checklistId)
  if (!c) notFound()

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10 space-y-6">
      <Link
        href="/app/admin/equipment"
        className="text-sm text-ink-muted underline-offset-2 hover:underline"
      >
        &larr; Equipment &amp; close-outs
      </Link>

      <header>
        <h1 className="text-2xl font-semibold">{c.providerName}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {c.serviceName} · {when(c.startTime)}
        </p>
        <p className="mt-0.5 text-xs text-ink-faint">Closed out {when(c.recordedAt)}</p>
      </header>

      {c.deviceIssue && (
        <section className="flex gap-4 rounded-card border border-critical/40 bg-critical/10 p-5">
          {c.photoStorageKey && (
            <Photo
              checkId={c.id}
              alt={`Laser, reported by ${c.providerName}`}
              deletedAt={c.photoDeletedAt}
            />
          )}
          <div className="min-w-0 space-y-1.5">
            <h2 className="text-sm font-medium">Device issue reported</h2>
            <p className="text-sm text-ink-secondary italic">&ldquo;{c.deviceIssueNote}&rdquo;</p>
            {c.photoStorageKey && !c.photoDeletedAt && <RemovePhoto checklistId={c.id} />}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          What came up
        </h2>
        {c.reportedLabels.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing beyond the required items.</p>
        ) : (
          <ul className="space-y-1">
            {c.reportedLabels.map((label) => (
              <li key={label} className="rounded-card border border-line px-3 py-2 text-sm">
                {label}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Note</h2>
        {c.note ? (
          <p className="whitespace-pre-wrap rounded-card border border-line p-3 text-sm">
            {c.note}
          </p>
        ) : (
          <p className="text-sm text-ink-muted">No note left.</p>
        )}
      </section>

      {/* Not "21 of 25": the unticked four are conditionals that simply did not come up, and a
          raw count reads as four things missed. Only a required item can be missed, and only on a
          row signed against an older checklist. */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Checklist</h2>
        {c.requiredMissingLabels.length === 0 ? (
          <p className="text-sm text-ink-secondary">Every required item was ticked.</p>
        ) : (
          <>
            <p className="text-sm text-ink-secondary">Required, but not ticked:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
              {c.requiredMissingLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  )
}
