'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { AmountField, FutureDateField, IntegerField } from '@/components/ui/validated-field'

import { createCourse, updateCourse, type TrainingState } from './actions'

export interface CourseDraft {
  id?: string
  day1Date: string
  day1Start: string
  day1End: string
  day2Date: string
  day2Start: string
  day2End: string
  maxStudents: string
  depositAmount: string
  totalPrice: string
}

const BLANK: CourseDraft = {
  day1Date: '',
  day1Start: '10:00',
  day1End: '16:00',
  day2Date: '',
  day2Start: '10:00',
  day2End: '14:00',
  maxStudents: '5',
  depositAmount: '500.00',
  totalPrice: '1400.00',
}

/** Create or edit a course. Defaults match what Melanite actually runs — two days, five seats,
 *  $500 deposit against $1,400 — so scheduling the usual course is a date and a save. */
export function CourseForm({
  initial,
  onDone,
}: {
  initial?: CourseDraft
  onDone?: () => void
}) {
  const [draft, setDraft] = useState<CourseDraft>(initial ?? BLANK)
  const [state, setState] = useState<TrainingState>({})
  const [pending, start] = useTransition()

  const set = (key: keyof CourseDraft) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }))

  function submit() {
    start(async () => {
      const payload = {
        day1Date: draft.day1Date,
        day1Start: draft.day1Start,
        day1End: draft.day1End,
        day2Date: draft.day2Date || null,
        day2Start: draft.day2Start,
        day2End: draft.day2End,
        maxStudents: Number(draft.maxStudents),
        depositAmount: Number(draft.depositAmount),
        totalPrice: Number(draft.totalPrice),
      }
      const result = draft.id
        ? await updateCourse(draft.id, payload)
        : await createCourse(payload)

      setState(result)
      if (result.success) {
        if (!draft.id) setDraft(BLANK)
        onDone?.()
      }
    })
  }

  return (
    <div className="space-y-4 rounded-card border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">{draft.id ? 'Edit course' : 'Schedule a course'}</h2>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* A course cannot be scheduled into the past. `min` greys the days out in the
            browser's own picker, which prevents the mistake rather than reporting it. */}
        <FutureDateField
          id="day1Date"
          label="Day one"
          value={draft.day1Date}
          onChange={set('day1Date')}
        />
        <Field
          id="day1Start"
          label="Starts"
          type="time"
          value={draft.day1Start}
          onChange={(e) => set('day1Start')(e.target.value)}
        />
        <Field
          id="day1End"
          label="Ends"
          type="time"
          value={draft.day1End}
          onChange={(e) => set('day1End')(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FutureDateField
          id="day2Date"
          label="Day two"
          value={draft.day2Date}
          onChange={set('day2Date')}
          optional
          hint="Leave blank for a one-day course"
        />
        <Field
          id="day2Start"
          label="Starts"
          type="time"
          value={draft.day2Start}
          disabled={!draft.day2Date}
          onChange={(e) => set('day2Start')(e.target.value)}
        />
        <Field
          id="day2End"
          label="Ends"
          type="time"
          value={draft.day2End}
          disabled={!draft.day2Date}
          onChange={(e) => set('day2End')(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <IntegerField
          id="maxStudents"
          label="Seats"
          min={1}
          max={50}
          value={draft.maxStudents}
          onChange={set('maxStudents')}
        />
        <AmountField
          id="depositAmount"
          label="Deposit"
          value={draft.depositAmount}
          onChange={set('depositAmount')}
        />
        <AmountField
          id="totalPrice"
          label="Total price"
          value={draft.totalPrice}
          onChange={set('totalPrice')}
        />
      </div>

      {state.error && <Notice>{state.error}</Notice>}
      {state.success && <Notice tone="success">{state.success}</Notice>}

      <Button onClick={submit} disabled={pending || !draft.day1Date}>
        {pending ? 'Saving…' : draft.id ? 'Save changes' : 'Schedule course'}
      </Button>
    </div>
  )
}
