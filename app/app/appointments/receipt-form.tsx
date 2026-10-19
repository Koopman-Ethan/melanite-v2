'use client'

import { useActionState, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import { downscaleImage, isTooBig, putBackInInput, TOO_BIG_MESSAGE } from '@/lib/uploads'

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
  late = false,
  open,
  onClose,
}: {
  bookingId: string
  /** What they last told Melanite, or null if they have not yet. */
  sentAmountCents: number | null
  /** The close-out window has passed without this being sent. Changes only the wording: the
   *  provider needs to know why they are being asked here rather than on the checklist, and
   *  that the checklist itself is gone for good. */
  late?: boolean
  /** Controlled by the card. See the note on `EndOfUseChecklist`. */
  open: boolean
  onClose: () => void
}) {
  const [state, action, pending] = useActionState<ReceiptState, FormData>(submitReceipt, {})
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  /** Refused in the browser, before anything is sent. Separate from `state.error`, which comes
   *  back from the server — this one never gets that far, which is the point of it. */
  const [fileError, setFileError] = useState<string | null>(null)

  // SHRINK FIRST, THEN REFUSE. A photo of a receipt off a modern phone is several megabytes and
  // would blow the server action body limit — at which point Next rejects the request before any
  // of our code runs and the provider sees "Body exceeded 1 MB limit", which is not a sentence
  // anybody can act on. Redrawing it smaller fixes almost every case.
  //
  // A PDF cannot be redrawn, so the size check is what catches the rest. Doing it here means the
  // file never leaves the browser rather than being uploaded and then rejected.
  async function onPickReceipt(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    if (!picked) return

    setFileError(null)
    setFileName(picked.name)

    const smaller = await downscaleImage(picked)

    if (isTooBig(smaller)) {
      setFileError(TOO_BIG_MESSAGE)
      setFileName(null)
      if (fileRef.current) fileRef.current.value = ''
      return
    }

    putBackInInput(fileRef.current, smaller)
  }

  if (!open) return null

  // SENT. The form collapses to its own confirmation rather than sitting there filled in —
  // leaving it open invites a second submission of the same figure, and the fields are no
  // longer the thing worth looking at. Matches `EndOfUseChecklist`, which has always done this.
  //
  // The green line stays until the card re-renders, at which point the row above shows "You
  // told Melanite $100.00 · Change it" and becomes the durable record.
  if (state.success) {
    return <p className="text-xs text-success">{state.success}</p>
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
            // `min-h-11` is what `Button` and `Field` both use — a 44px touch target. Without
            // it this sat visibly shorter than the two buttons next to it.
            className="mt-1 w-28 min-h-11 rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink tabular-nums"
          />
        </label>

        <div className="text-xs">
          <span className="block text-ink-faint">Receipt</span>
          <input
            ref={fileRef}
            type="file"
            name="receipt"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={onPickReceipt}
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

        {/* The way out, matching the close-out panel beside it. Without one the only escape
            from an opened form is the trigger that opened it, which is now above the panel
            rather than beside it. */}
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Not now
        </Button>
      </div>

      {fileName && <p className="text-xs text-ink-faint">Attached: {fileName}</p>}
      {fileError && <Notice>{fileError}</Notice>}

      {/* The redaction prompt, next to the control it is about rather than in a policy page
          nobody opens. Phrased as a thing to do, not a warning: "cover the name" is an action,
          "we may store personal data" is a sentence people skip. */}
      <p className="text-xs text-ink-faint">
        <strong className="text-ink-secondary">Cover your client&rsquo;s name</strong> before you
        photograph it — Melanite only needs the amount and the date. The receipt is deleted once
        Keoni has settled the session, and the figure above is kept.
      </p>

      {state.error && <Notice>{state.error}</Notice>}
    </form>
  )
}
