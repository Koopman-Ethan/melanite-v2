'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { setNewPassword, type ResetState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-[#B8965A] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Set password'}
    </button>
  )
}

export function ResetForm({ token }: { token: string }) {
  const [state, formAction] = useActionState<ResetState, FormData>(setNewPassword, {})

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-medium">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          autoFocus
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[#B8965A] dark:border-white/20"
        />
        <p className="text-xs opacity-60">At least 12 characters, with a letter and a number.</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="confirm" className="block text-sm font-medium">
          Confirm password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[#B8965A] dark:border-white/20"
        />
      </div>

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-[#c75c5c]/30 bg-[#c75c5c]/10 px-3 py-2 text-sm text-[#c75c5c]"
        >
          {state.error}
        </p>
      )}

      <SubmitButton />

      <p className="pt-1 text-xs opacity-60">
        Setting a new password signs you out everywhere else.
      </p>
    </form>
  )
}
