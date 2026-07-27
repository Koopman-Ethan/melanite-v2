'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { login, type LoginState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" block disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  )
}

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {})

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={next ?? '/app'} />

      <Field id="email" name="email" type="email" label="Email" autoComplete="email" required />
      <Field
        id="password"
        name="password"
        type="password"
        label="Password"
        autoComplete="current-password"
        required
      />

      {state.error && <Notice>{state.error}</Notice>}

      <SubmitButton />

      <p className="text-center text-sm">
        <Link href="/forgot-password" className="text-ink-muted underline-offset-4 hover:text-ink-secondary hover:underline">
          Forgot your password?
        </Link>
      </p>

      <p className="pt-1 text-center text-xs text-ink-faint">
        Moving over from the old portal? Your password didn&rsquo;t carry across — use
        &ldquo;Forgot your password?&rdquo; to set a new one.
      </p>
    </form>
  )
}
