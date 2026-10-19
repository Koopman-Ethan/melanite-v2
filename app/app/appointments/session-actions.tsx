'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { EndOfUseChecklist } from './end-of-use-checklist'
import { ReceiptForm } from './receipt-form'

// The two things a provider does with a session that has finished: say how they left the room,
// and say what they charged.
//
// WHY THIS COMPONENT EXISTS. Each one used to own whether it was open, which meant its trigger
// and its panel had to be in the same place — so opening one unfolded a whole form inside half
// a flex row and shouldered the other button aside while somebody was part-way through reading
// it. The triggers belong together on one line; the panel belongs underneath both of them,
// full width.
//
// ONE AT A TIME. Two forms open at once in a card this size is a scroll hunt, and the second
// one pushes the first off screen as it opens. Opening either closes the other, which also
// means the answer to "where did my form go" is always "it is the one on screen".
//
// Each is independently optional. The close-out goes on a cancellation, on a no-show, and
// twelve hours after any session; the receipt only ever appears for a rental booking of a
// provider whose fee Keoni sets. Either can be the only one here, and often is.

type Panel = 'closeout' | 'receipt' | null

export function SessionActions({
  bookingId,
  closeoutOffered,
  recorded,
  receiptOffered,
  sentAmountCents,
  sentAt,
  late,
}: {
  bookingId: string
  closeoutOffered: boolean
  recorded: { itemsDone: number; itemCount: number; deviceIssue: boolean } | null
  receiptOffered: boolean
  sentAmountCents: number | null
  sentAt: string | null
  /** The close-out window has passed. Only changes wording inside the receipt panel. */
  late: boolean
}) {
  const [open, setOpen] = useState<Panel>(null)

  // Already done, both of them. Rendered as status rather than as a button, because there is
  // nothing left to press — but the receipt stays editable, since a wrong figure has to be
  // fixable right up until Keoni acts on it.
  const closedOut = recorded !== null
  const sent = sentAmountCents !== null

  const sentOn = sentAt
    ? new Date(sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  const toggle = (panel: Panel) => setOpen((current) => (current === panel ? null : panel))

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        {closeoutOffered && !closedOut && (
          <div>
            <Button
              size="sm"
              variant={open === 'closeout' ? 'gold' : 'outline'}
              onClick={() => toggle('closeout')}
            >
              Close out the suite
            </Button>
            {/* "After appointment", not "end of day". Somebody who reads this as a daily form
                files one a day and then wonders why they are chased for the other four. */}
            <p className="mt-1.5 text-[11px] text-ink-faint">After appointment checklist</p>
          </div>
        )}

        {receiptOffered && !sent && (
          <div>
            <Button
              size="sm"
              variant={open === 'receipt' ? 'gold' : 'outline'}
              onClick={() => toggle('receipt')}
            >
              Submit Client Receipt
            </Button>
            <p className="mt-1.5 text-[11px] text-ink-faint">
              {late ? 'The check-off has closed — this has not' : 'Keoni sets your fee from this'}
            </p>
          </div>
        )}

        {closedOut && (
          <div className="text-xs">
            <p className={recorded.itemsDone >= recorded.itemCount ? 'text-success' : 'text-ink-muted'}>
              {recorded.itemsDone >= recorded.itemCount
                ? '✓ Closed out — everything ticked.'
                : `Closed out — ${recorded.itemsDone} of ${recorded.itemCount}.`}
            </p>
            {recorded.deviceIssue && (
              <p className="mt-1 text-critical">Device issue reported. Melanite has it.</p>
            )}
          </div>
        )}

        {receiptOffered && sent && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
            <span>
              You told Melanite{' '}
              <strong className="text-ink">${(sentAmountCents / 100).toFixed(2)}</strong>
              {sentOn ? ` on ${sentOn}` : ''}.
            </span>
            <button
              type="button"
              onClick={() => toggle('receipt')}
              className="text-ink-faint underline-offset-4 hover:text-ink hover:underline"
            >
              Change it
            </button>
          </div>
        )}
      </div>

      {/* THE PANEL, under the whole row rather than inside one cell. */}
      {open !== null && (
        <div className="mt-3">
          <EndOfUseChecklist
            bookingId={bookingId}
            recorded={recorded}
            open={open === 'closeout'}
            onClose={() => setOpen(null)}
          />
          <ReceiptForm
            bookingId={bookingId}
            sentAmountCents={sentAmountCents}
            late={late}
            open={open === 'receipt'}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </div>
  )
}
