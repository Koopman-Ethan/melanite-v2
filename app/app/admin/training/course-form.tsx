'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

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
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium text-ink-secondary">Day one</span>
          <input
            type="date"
            value={draft.day1Date}
            onChange={(e) => set('day1Date')(e.target.value)}
            className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        </label>
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
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium text-ink-secondary">Day two</span>
          <input
            type="date"
            value={draft.day2Date}
            onChange={(e) => set('day2Date')(e.target.value)}
            className="w-full rounded-field border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
          <span className="block text-xs text-ink-faint">Leave blank for a one-day course</span>
        </label>
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
        <Field
          id="maxStudents"
          label="Seats"
          type="number"
          min={1}
          value={draft.maxStudents}
          onChange={(e) => set('maxStudents')(e.target.value)}
        />
        <Field
          id="depositAmount"
          label="Deposit"
          type="number"
          min={0}
          step={0.01}
          value={draft.depositAmount}
          onChange={(e) => set('depositAmount')(e.target.value)}
        />
        <Field
          id="totalPrice"
          label="Total price"
          type="number"
          min={0}
          step={0.01}
          value={draft.totalPrice}
          onChange={(e) => set('totalPrice')(e.target.value)}
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
