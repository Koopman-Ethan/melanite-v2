'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { requestReset, type ForgotState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-[#B8965A] px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {pending ? 'Sending…' : 'Send reset link'}
    </button>
  )
}

export function ForgotForm() {
  const [state, formAction] = useActionState<ForgotState, FormData>(requestReset, {})

  if (state.sent) {
    return (
      <div className="space-y-4">
        <p className="rounded-md border border-[#7fa87f]/30 bg-[#7fa87f]/10 px-3 py-3 text-sm">
          If that email is registered, a reset link is on its way. It expires in one hour.
        </p>
        {state.devLink && (
          <div className="rounded-md border border-[#d4a04e]/40 bg-[#d4a04e]/10 px-3 py-3 text-xs">
            <p className="font-medium">Development only — no email provider configured</p>
            <a href={state.devLink} className="mt-1 block break-all underline">
              {state.devLink}
            </a>
          </div>
        )}
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
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
    </form>
  )
}
