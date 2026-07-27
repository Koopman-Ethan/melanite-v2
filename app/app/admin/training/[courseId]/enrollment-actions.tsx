'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'

import {
  cancelCourse,
  markCourseComplete,
  sendBalanceLink,
  setBalanceDueDate,
  type TrainingState,
} from '../actions'

export function CourseControls({
  courseId,
  status,
  enrolled,
}: {
  courseId: string
  status: string
  enrolled: number
}) {
  const [state, setState] = useState<TrainingState>({})
  const [confirming, setConfirming] = useState<'complete' | 'cancel' | null>(null)
  const [pending, start] = useTransition()

  if (status !== 'scheduled') {
    return (
      <p className="text-xs text-ink-faint">
        This course is {status}. Its details can no longer be edited.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {state.error && <Notice>{state.error}</Notice>}
      {state.success && <Notice tone="success">{state.success}</Notice>}

      {confirming === 'complete' ? (
        <div className="space-y-2 rounded-field border border-line bg-overlay p-3">
          <p className="text-xs text-ink-secondary">
            Mark this course complete? All {enrolled} enrolments get stamped as completed.
            Provider invites are still sent separately — finishing the course is not the same as
            being cleared to practise.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setState(await markCourseComplete(courseId))
                  setConfirming(null)
                })
              }
            >
              {pending ? 'Working…' : 'Yes, complete it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : confirming === 'cancel' ? (
        <div className="space-y-2 rounded-field border border-line bg-overlay p-3">
          <p className="text-xs text-ink-secondary">
            Cancel this course? Deposits already taken are <strong>not</strong> refunded
            automatically — they may be transferable to another date, which is a conversation
            rather than a rule.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setState(await cancelCourse(courseId))
                  setConfirming(null)
                })
              }
            >
              {pending ? 'Working…' : 'Yes, cancel'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setConfirming('complete')}>
            Mark complete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming('cancel')}>
            Cancel course
          </Button>
        </div>
      )}
    </div>
  )
}

export function EnrollmentControls({
  enrollmentId,
  owed,
  balanceDueDate,
}: {
  enrollmentId: string
  owed: string
  balanceDueDate: string | null
}) {
  const [state, setState] = useState<TrainingState>({})
  const [dueDate, setDueDate] = useState(balanceDueDate ?? '')
  const [pending, start] = useTransition()

  const owesMoney = Number(owed) > 0

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-end gap-2">
        {owesMoney && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => start(async () => setState(await sendBalanceLink(enrollmentId)))}
          >
            {pending ? 'Sending…' : 'Send balance link'}
          </Button>
        )}

        <label className="text-xs">
          <span className="block text-ink-faint">Balance due by</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value)
              start(async () => setState(await setBalanceDueDate(enrollmentId, e.target.value || null)))
            }}
            className="mt-1 rounded-field border border-line bg-surface px-2 py-1.5 text-xs text-ink"
          />
        </label>
      </div>

      {state.error && <p className="text-xs text-danger">{state.error}</p>}
      {state.success && <p className="text-xs text-success">{state.success}</p>}
      {/* Shown whenever a link exists, because email is not guaranteed to be configured and a
          link the admin cannot see is a link nobody can send. */}
      {state.url && (
        <p className="break-all text-xs text-ink-faint">{state.url}</p>
      )}
    </div>
  )
}
