'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { setNewPassword, type ResetState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" block disabled={pending}>
      {pending ? 'Saving…' : 'Set password'}
    </Button>
  )
}

export function ResetForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ResetState, FormData>(setNewPassword, {})

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <Field
        id="password"
        name="password"
        type="password"
        label="New password"
        autoComplete="new-password"
        required
        minLength={12}
        autoFocus
        hint="At least 12 characters, with a letter and a number."
      />
      <Field
        id="confirm"
        name="confirm"
        type="password"
        label="Confirm password"
        autoComplete="new-password"
        required
        minLength={12}
      />

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton />

      <p className="pt-1 text-xs text-ink-faint">
        Setting a new password signs you out everywhere else.
      </p>
    </form>
  )
}
