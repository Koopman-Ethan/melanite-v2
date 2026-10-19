'use client'

import { useActionState, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { submitReceipt } from './receipt-actions'
import type { ReceiptState } from '@/lib/rental/receipts'

// Telling Keoni what a session was worth.
//
// Only shown to the three on `keoni_sets`, and only once a session has finished. Melanite works
// out no fee for them: this is the input she sets one from.
//
// THE AMOUNT IS THE POINT AND THE FILE IS EVIDENCE. It would have been easier to build this as
// a file upload, and worse — Keoni would open a photograph of somebody's receipt to answer
// every session, three a week, for ever. A number on the queue means she reads and charges, and
// opens the document only when it does not look right.
//
// WHY IT ASKS THEM TO COVER THE NAME. The rental terms promise that Melanite keeps no record of
// who their clients are, and a receipt usually names one. Asking at the moment of photographing
// is the only control that stops the data arriving at all; everything after that is damage
// limitation. The file is deleted once Keoni has charged or waived — see `forgetReceipt`.

export function ReceiptForm({
  bookingId,
  sentAmountCents,
  sentAt,
  late = false,
}: {
  bookingId: string
  /** What they last told Melanite, or null if they have not yet. */
  sentAmountCents: number | null
  sentAt: Date | null
  /** The close-out window has passed without this being sent. Changes only the wording: the
   *  provider needs to know why they are being asked here rather than on the checklist, and
   *  that the checklist itself is gone for good. */
  late?: boolean
}) {
  const [state, action, pending] = useActionState<ReceiptState, FormData>(submitReceipt, {})
  const [open, setOpen] = useState(sentAmountCents === null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

  // Already sent, and not being edited. Deliberately still editable: a provider who typed the
  // wrong figure must be able to correct it before Keoni acts, and after she has acted the
  // item has left her queue anyway.
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
        <span>
          You told Melanite{' '}
          <strong className="text-ink">{usd(sentAmountCents ?? 0)}</strong>
          {sentAt
            ? ` on ${sentAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
            : ''}
          . Keoni sets what you owe from it.
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-ink-faint underline-offset-4 hover:text-ink hover:underline"
        >
          Change it
        </button>
      </div>
    )
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="bookingId" value={bookingId} />

      <p className="text-xs text-ink-secondary">
        <strong className="text-ink">What did you charge your client?</strong> Melanite does not
        set a price for your sessions — Keoni works out what you owe from this.
      </p>

      {late && sentAmountCents === null && (
        <p className="text-xs text-ink-faint">
          The twelve hours for signing this session off have passed, so the check-off is closed.
          This part is not — Keoni still needs the figure before she can settle it.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="block text-ink-faint">Amount</span>
          <input
            type="number"
            name="amount"
            min={0}
            step={0.01}
            required
            defaultValue={sentAmountCents === null ? '' : (sentAmountCents / 100).toFixed(2)}
            placeholder="0.00"
            className="mt-1 w-28 rounded-field border border-line bg-surface px-2 py-1.5 text-xs text-ink tabular-nums"
          />
        </label>

        <div className="text-xs">
          <span className="block text-ink-faint">Receipt</span>
          <input
            ref={fileRef}
            type="file"
            name="receipt"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            className="hidden"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-1"
            onClick={() => fileRef.current?.click()}
          >
            {fileName ? 'Choose another' : 'Attach a photo or PDF'}
          </Button>
        </div>

        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Sending…' : 'Send to Keoni'}
        </Button>
      </div>

      {fileName && <p className="text-xs text-ink-faint">Attached: {fileName}</p>}

      {/* The redaction prompt, next to the control it is about rather than in a policy page
          nobody opens. Phrased as a thing to do, not a warning: "cover the name" is an action,
          "we may store personal data" is a sentence people skip. */}
      <p className="text-xs text-ink-faint">
        <strong className="text-ink-secondary">Cover your client&rsquo;s name</strong> before you
        photograph it — Melanite only needs the amount and the date. The receipt is deleted once
        Keoni has settled the session, and the figure above is kept.
      </p>

      {state.error && <Notice>{state.error}</Notice>}
      {state.success && (
        <p className="text-xs text-success">{state.success}</p>
      )}
    </form>
  )
}
