'use client'

import { useState } from 'react'

import { Notice } from '@/components/ui/field'

import { RedeemForm, type RedeemLine } from './redeem-form'

// The session lines on one client's package, each with a way to book it.
//
// A client component only because the form needs to open and close. The progress bars were
// already here; the only thing added is that a line with sessions left is now actionable
// instead of being a read-out of something the provider could not do anything about.

export function BalanceLines({
  clientPackageId,
  clientName,
  lines,
  expired,
}: {
  clientPackageId: string
  clientName: string
  lines: Array<RedeemLine & { perSessionValue: string }>
  /** Past its expiry date. The server refuses these too — this only avoids offering a button
   *  whose one outcome is an error message. */
  expired: boolean
}) {
  const [open, setOpen] = useState<string | null>(null)
  // Held here rather than in the form, because the form unmounts on success and took its own
  // confirmation with it — the booking worked and the screen said nothing.
  const [done, setDone] = useState<string | null>(null)

  return (
    <ul className="mt-4 space-y-1.5">
      {done && (
        <li>
          <Notice tone="success">{done}</Notice>
        </li>
      )}
      {lines.map((l) => {
        const left = l.qtyTotal - l.qtyUsed
        return (
          <li key={l.itemId}>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{l.serviceName}</span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-gold"
                  style={{ width: `${(l.qtyUsed / l.qtyTotal) * 100}%` }}
                />
              </span>
              <span className="w-20 text-right tabular-nums text-ink-faint">
                {left} of {l.qtyTotal}
              </span>
              {left > 0 && !expired && (
                <button
                  type="button"
                  onClick={() => setOpen(open === l.itemId ? null : l.itemId)}
                  className="rounded-field border border-line-control px-2.5 py-1 text-xs text-ink hover:border-gold"
                >
                  {open === l.itemId ? 'Close' : 'Book'}
                </button>
              )}
            </div>

            {open === l.itemId && (
              <RedeemForm
                clientPackageId={clientPackageId}
                line={l}
                clientName={clientName}
                onDone={(success) => {
                  setOpen(null)
                  if (success) setDone(success)
                }}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
