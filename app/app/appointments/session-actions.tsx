'use client'

import { useCallback, useState } from 'react'

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

  // Bumped to force a FRESH receipt form.
  //
  // After a successful send the panel collapses to its green confirmation, which lives in
  // `useActionState` inside the form. Re-opening the same mounted component would show that
  // confirmation again rather than the fields — so "Change it" appeared to do nothing, or
  // worse: as a toggle it CLOSED the panel, taking the confirmation with it, and a second
  // click was needed to get the form back. Remounting clears the action state, which is the
  // only way back to an editable form from a submitted one.
  const [editing, setEditing] = useState(0)

  /** The receipt panel is showing its SENT confirmation rather than the fields.
   *
   *  The parent cannot see inside `useActionState`, so the form says so — and without knowing
   *  which of the two the panel is showing, "Change it" cannot both open the fields from a
   *  confirmation and close them again on a second press. */
  const [justSent, setJustSent] = useState(false)

  // Already done, both of them. Rendered as status rather than as a button, because there is
  // nothing left to press — but the receipt stays editable, since a wrong figure has to be
  // fixable right up until Keoni acts on it.
  const closedOut = recorded !== null
  const sent = sentAmountCents !== null

  const sentOn = sentAt
    ? new Date(sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  // Stable, so the effect in `ReceiptForm` that calls it does not re-fire on every render of
  // this component. An inline arrow is a new function each time and lands in that dependency
  // array; setting the same value is a React no-op so nothing looped, but it ran constantly.
  const markSent = useCallback(() => setJustSent(true), [])

  const toggle = (panel: Panel) =>
    setOpen((current) => {
      setJustSent(false)
      return current === panel ? null : panel
    })

  /** Opens the fields, or closes them if they are already up.
   *
   *  It toggles against the FIELDS, not against the panel. Pressing it while the panel shows
   *  the sent confirmation opens the fields — closing there would take the confirmation away
   *  and need a second press to get anywhere, which is what it used to do.
   *
   *  Re-opening forces a fresh mount, because the confirmation lives in `useActionState`
   *  inside the form and a remount is the only way back to editable fields. */
  const amend = () => {
    const showingFields = open === 'receipt' && !justSent
    if (showingFields) {
      setOpen(null)
      return
    }
    setJustSent(false)
    setEditing((n) => n + 1)
    setOpen('receipt')
  }

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
          // `min-h-11` is the BUTTON's height, so a one-line status sits level with the
          // control beside it instead of floating at the top of a taller column. The row is
          // `items-start` because the buttons carry subtitles under them; a bare line of text
          // has nothing under it and would otherwise ride up.
          <div className="flex min-h-11 flex-col justify-center text-xs">
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
          <div className="flex min-h-11 flex-wrap items-center gap-2 text-xs text-ink-secondary">
            <span>
              You told Melanite{' '}
              <strong className="text-ink">${(sentAmountCents / 100).toFixed(2)}</strong>
              {sentOn ? ` on ${sentOn}` : ''}.
            </span>
            <button
              type="button"
              onClick={amend}
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
            key={editing}
            onSent={markSent}
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
