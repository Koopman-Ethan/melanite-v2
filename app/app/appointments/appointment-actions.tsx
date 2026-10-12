'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import type { Appointment } from '@/lib/db/queries/appointments'

import {
  cancelBooking,
  cancelPackageRedemption,
  cancelPrepaidBooking,
  markCompleted,
  markNoShow,
  type ActionState,
} from './actions'

/** Actions available on one appointment.
 *
 *  Which cancel is offered comes from the booking itself, so the provider is never asked to
 *  know the difference. In v1 both paths looked identical — a redemption came back as an
 *  ordinary $0 booking — and picking wrong destroyed a paid session, which is why the backend
 *  had to refuse with USE_PACKAGE_CANCEL. Here the right button is simply the only one shown.
 *
 *  There are three now: an ordinary cancel, one that returns a package session, and one that
 *  returns prepaid money. The third was missing for a day — the server action existed, was
 *  tested, and refused the ordinary cancel with a message naming a button nobody had built,
 *  which left the provider reading an instruction they could not follow. Exactly what the
 *  paragraph above says this component exists to prevent.
 */
/** Keep in step with `MIN_REASON` in `./actions`. Duplicated rather than imported because that
 *  module is `server-only` and importing it here would pull the database into the bundle.
 *
 *  The server is the one that enforces it. This copy only decides when the button lights up, so
 *  a provider is not told "too short" after pressing it. */
const MIN_REASON = 10

export function AppointmentActions({ appointment }: { appointment: Appointment }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<ActionState>({})
  const [confirming, setConfirming] = useState<'cancel' | 'no_show' | null>(null)
  const [reason, setReason] = useState('')

  // NOT a bare `return null`.
  //
  // Every action here moves the appointment out of `upcoming` — cancel, complete, no-show — so
  // the instant one succeeds this component stops rendering and takes its own confirmation with
  // it. The provider sees a green flash too brief to read and has no way to tell a cancellation
  // that returned $75 from one that did not.
  //
  // Fixing it with a timer would not work: the message is not fading, it is being unmounted.
  // So the buttons go and the message stays, until the provider navigates away.
  if (appointment.status !== 'upcoming') {
    if (!state.success && !state.feeNote) return null
    return (
      <div className="space-y-1">
        {state.success && <p className="text-xs text-success">{state.success}</p>}
        {state.feeNote && <p className="text-xs text-warning">{state.feeNote}</p>}
      </div>
    )
  }

  const isPast = appointment.startTime <= new Date()
  // Over, not merely started. A session still running can be called off; one that has finished
  // has two honest endings, Completed or No-show, and `cancelBooking` refuses it server-side.
  const isFinished = appointment.endTime <= new Date()
  const restoresSession = appointment.isPackageRedemption
  const returnsBalance = appointment.isPrepaidRedemption
  // Either kind of prepaid value coming back. Both refuse the ordinary cancel server-side, so
  // this decides which of the two specific buttons is offered.
  const returnsValue = restoresSession || returnsBalance

  const run = (fn: (id: string) => Promise<ActionState>) => {
    startTransition(async () => {
      setState(await fn(appointment.id))
      setConfirming(null)
    })
  }

  // A fee is never charged as a side effect of a status change. Both paths ask first, and both
  // offer the no-fee option beside the fee one — a provider who does not want to bill a regular
  // client should not have to avoid the button that records what happened.
  const canCharge = appointment.paymentSource === 'checkout_link' && Number(appointment.price) > 0
  // A rental booking has no client and no payment link — the only money on it is the rent the
  // provider paid. Every other branch here describes a client's money.
  const isRental = appointment.paymentSource === 'rental'

  // Whether a decision about rent hangs on this appointment.
  //
  // THIS USED TO ASK "was money taken?", which was the same question while the fee was charged
  // at booking. Since 12 October it is taken twelve hours after the session, so a booking
  // cancelled before then has had nothing charged — and that test answered no, hid the reason
  // box, and let the cancellation through with no explanation, no queue item and no sweep. The
  // session vanished and Melanite lost the rent silently. Ethan hit it within a minute of
  // testing.
  //
  // `rentalCents === null` means nothing charged YET, which is the ordinary state and still
  // owes a reason. Only an explicit zero — charged and fully refunded — is settled.
  // EVERY provider is asked what happened, not only the ones who pay rent.
  //
  // Keoni's instruction was unconditional — "no matter how the appointment gets cancelled,
  // whether its a noshow or a cancellation, there needs to be a popup that asks what happened
  // that will allow keoni to review it" — and gating it on rent made it true for five providers
  // and false for the three she grandfathered.
  //
  // The two arrangements turn out to be the same shape. On the 50/50 the provider sends a link
  // and the client pays AFTER the service, exactly as rent is now taken after the session, so
  // at the moment of a cancellation nobody has paid anything either way. The question Keoni
  // answers is the same one: does the provider owe Melanite for a session that did not happen?
  // Only the amount differs — the published fee, or Melanite's half of their own price.
  const holdsRent =
    isRental && (appointment.paidFromCredit || appointment.rentalCents !== 0)
  const owesSplit = !isRental && Number(appointment.price) > 0
  const asksWhy = holdsRent || owesSplit

  const rentLabel = appointment.paidFromCredit
    ? 'pack session'
    : appointment.rentalCents === null
      ? 'rental fee'
      : `$${(appointment.rentalCents / 100).toFixed(2)} rental fee`

  // The gate Keoni asked for: no path out of an appointment that holds rent without saying what
  // happened. Deliberately the same for a cancellation and a no-show — she withdrew the
  // automatic no-show refund precisely because the two were being treated differently.
  // Whether the money has actually moved yet, which decides the wording. "Held, not refunded"
  // is true of a fee already taken and a lie about one that never was.
  const rentTaken = appointment.paidFromCredit || (appointment.rentalCents ?? 0) > 0
  const rentSentence = !isRental
    ? 'Nothing has been charged. Melanite decides whether its half of this session is still owed.'
    : rentTaken
      ? `Your ${rentLabel} is held, not refunded — Melanite decides whether it stands.`
      : `Your ${rentLabel} has not been taken. Melanite decides whether it is owed.`

  const reasonOk = !asksWhy || reason.trim().length >= MIN_REASON

  /** The reason box, worded for which of the two endings this is.
   *
   *  The mechanics are identical — both ask, neither charges, both go to Keoni — and that is
   *  exactly why the copy has to differ. Two dialogs that read the same make the two buttons
   *  look like a redundant choice, which is how somebody ends up picking either one and losing
   *  the distinction Keoni decides on.
   *
   *  What separates them is what happened to the HOUR. A cancellation hands the slot back and
   *  somebody else can take it; a no-show burns it on a single shared machine that nobody could
   *  book. That is usually the difference between waiving the fee and charging it, so the
   *  prompt says so rather than leaving her to infer it from free text. */
  const reasonBox = (kind: 'cancel' | 'no_show') =>
    asksWhy ? (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-ink">
        {kind === 'no_show' ? 'What happened? Nobody came.' : 'What happened?'}
      </span>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        placeholder={
          kind === 'no_show'
            ? 'e.g. Client confirmed the day before and never arrived or replied.'
            : 'e.g. Client asked to move it and I could not fill the slot.'
        }
        className="w-full rounded-field border border-line-control bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold"
      />
      <span className="block text-xs text-ink-faint">
        {kind === 'no_show'
          ? 'Nobody else could use that hour, so Melanite weighs this one differently. '
          : 'The slot has gone back on the calendar for somebody else. '}
        Melanite reads this to decide whether this session is owed for. Your side of it is the
        only side there is, so say enough to be going on with.
      </span>
    </label>
    ) : null

  return (
    <div className="space-y-2">
      {state.error && <p className="text-xs text-danger">{state.error}</p>}
      {state.success && <p className="text-xs text-success">{state.success}</p>}
      {state.feeNote && <p className="text-xs text-warning">{state.feeNote}</p>}

      {confirming === 'no_show' ? (
        <div className="space-y-2 rounded-field border border-line bg-overlay p-3">
          <p className="text-xs text-ink-secondary">
            {asksWhy
              ? `Mark this as a no-show — the hour is gone and nobody else could book it. ${rentSentence} You will hear once it has been looked at.`
              : `Mark ${appointment.clientName} as a no-show. Charging the fee uses the card they left on file — if there is none, the status is still recorded and nothing is charged.`}
          </p>
          {reasonBox('no_show')}
          <div className="flex flex-wrap gap-2">
            {canCharge && (
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => run((id) => markNoShow(id, reason, true))}
              >
                {pending ? 'Working…' : 'No-show and charge fee'}
              </Button>
            )}
            <Button
              size="sm"
              variant={canCharge ? 'outline' : 'danger'}
              disabled={pending || !reasonOk}
              onClick={() => run((id) => markNoShow(id, reason, false))}
            >
              {pending ? 'Working…' : canCharge ? 'No-show, no fee' : 'Mark as no-show'}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : confirming === 'cancel' ? (
        <div className="space-y-2 rounded-field border border-line bg-overlay p-3">
          <p className="text-xs text-ink-secondary">
            {restoresSession
              ? 'Cancel this appointment and return the session to the client’s package?'
              : returnsBalance
                ? 'Cancel this appointment and put the money back on the client’s prepaid balance? Anything they have already paid on a card is refunded in Stripe, not here.'
                : asksWhy
                  ? `Cancel this appointment? The slot reopens straight away for somebody else. ${rentSentence}`
                  : isRental
                    ? 'Cancel this appointment? The slot reopens.'
                    : 'Cancel this appointment? The client’s payment link will be cancelled if it is still unpaid.'}
          </p>
          {reasonBox('cancel')}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={pending || !reasonOk}
              onClick={() =>
                run(
                  restoresSession
                    ? cancelPackageRedemption
                    : returnsBalance
                      ? cancelPrepaidBooking
                      : (id) => cancelBooking(id, reason),
                )
              }
            >
              {pending ? 'Cancelling…' : 'Yes, cancel'}
            </Button>
            {!returnsValue && canCharge && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run((id) => cancelBooking(id, reason, true))}
              >
                Cancel and charge late fee
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {isPast && (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(markCompleted)}>
                Completed
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                // A rental no-show USED TO RUN FROM HERE with no dialog at all, because there
                // was no fee to ask about and the refund was automatic. Now it is the one that
                // most needs asking: the provider is about to keep or lose real money on the
                // strength of what they type.
                onClick={() =>
                  canCharge || asksWhy
                    ? setConfirming('no_show')
                    : run((id) => markNoShow(id, '', false))
                }
              >
                No-show
              </Button>
            </>
          )}
          {/* Hidden rather than disabled once the session is over: a greyed-out Cancel invites
              somebody to hunt for why, when the answer is that Completed and No-show beside it
              are the two things they actually want. */}
          {!isFinished && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming('cancel')}>
            {restoresSession
              ? 'Cancel and restore session'
              : returnsBalance
                ? 'Cancel and return the balance'
                : 'Cancel'}
          </Button>
          )}
        </div>
      )}
    </div>
  )
}
