'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { requestReset, type ForgotState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" block disabled={pending}>
      {pending ? 'Sending…' : 'Send reset link'}
    </Button>
  )
}

export function ForgotForm() {
  const [state, formAction] = useActionState<ForgotState, FormData>(requestReset, {})

  if (state.sent) {
    return (
      <div className="space-y-4">
        <Notice tone="success">
          If that email is registered, a reset link is on its way. It expires in one hour.
        </Notice>
        {state.devLink && (
          <div className="rounded-field border border-warning/40 bg-warning/10 px-3 py-3 text-xs">
            <p className="font-medium text-warning">Development only — no email provider configured</p>
            <a href={state.devLink} className="mt-1 block break-all text-ink-secondary underline">
              {state.devLink}
            </a>
          </div>
        )}
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <Field id="email" name="email" type="email" label="Email" autoComplete="email" required autoFocus />
      {state.error && <Notice>{state.error}</Notice>}
      <SubmitButton />
    </form>
  )
}
