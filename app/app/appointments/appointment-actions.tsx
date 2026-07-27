'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import type { Appointment } from '@/lib/db/queries/appointments'

import {
  cancelBooking,
  cancelPackageRedemption,
  markCompleted,
  markNoShow,
  type ActionState,
} from './actions'

/** Actions available on one appointment.
 *
 *  Which cancel is offered comes from `isPackageRedemption`, so the provider is never asked to
 *  know the difference. In v1 both paths looked identical — a redemption came back as an
 *  ordinary $0 booking — and picking wrong destroyed a paid session, which is why the backend
 *  had to refuse with USE_PACKAGE_CANCEL. Here the right button is simply the only one shown.
 */
export function AppointmentActions({ appointment }: { appointment: Appointment }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<ActionState>({})
  const [confirming, setConfirming] = useState<'cancel' | 'no_show' | null>(null)

  if (appointment.status !== 'upcoming') return null

  const isPast = appointment.startTime <= new Date()
  const restoresSession = appointment.isPackageRedemption

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

  return (
    <div className="space-y-2">
      {state.error && <p className="text-xs text-danger">{state.error}</p>}
      {state.success && <p className="text-xs text-success">{state.success}</p>}
      {state.feeNote && <p className="text-xs text-warning">{state.feeNote}</p>}

      {confirming === 'no_show' ? (
        <div className="space-y-2 rounded-field border border-line bg-overlay p-3">
          <p className="text-xs text-ink-secondary">
            Mark {appointment.clientName} as a no-show. Charging the fee uses the card they left
            on file — if there is none, the status is still recorded and nothing is charged.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() => run((id) => markNoShow(id, true))}
            >
              {pending ? 'Working…' : 'No-show and charge fee'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run((id) => markNoShow(id, false))}
            >
              No-show, no fee
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
              : 'Cancel this appointment? The client’s payment link will be cancelled if it is still unpaid.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() => run(restoresSession ? cancelPackageRedemption : cancelBooking)}
            >
              {pending ? 'Cancelling…' : 'Yes, cancel'}
            </Button>
            {!restoresSession && canCharge && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run((id) => cancelBooking(id, true))}
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
                onClick={() => (canCharge ? setConfirming('no_show') : run((id) => markNoShow(id, false)))}
              >
                No-show
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming('cancel')}>
            {restoresSession ? 'Cancel and restore session' : 'Cancel'}
          </Button>
        </div>
      )}
    </div>
  )
}
