'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { PASSWORD_CHECKS } from '@/lib/auth/password-policy'
import { cn } from '@/lib/cn'

import { activateAccount } from './actions'

// Step 1 of 6: create a password and activate the account.
//
// v1's first screen said "STEP 1 OF 5" while every screen after it said "OF 6" — its own
// sidebar listed five steps and omitted Medical Director. Six is correct and used throughout.

export const STEPS = [
  { n: 1, title: 'Create Password', blurb: 'Secure your account' },
  { n: 2, title: 'Personal Profile', blurb: 'Name, phone, credentials' },
  { n: 3, title: 'License & Compliance', blurb: 'Verify your credentials' },
  { n: 4, title: 'Connect Stripe', blurb: 'For automatic payouts' },
  { n: 5, title: 'Medical Director', blurb: 'Physician oversight' },
  { n: 6, title: 'Select Services', blurb: 'Set pricing and duration' },
] as const

/** The persistent right-hand rail: where you are, and why this step is being asked for.
 *
 *  Not decoration. Someone handing over a license number and bank details deserves to see what
 *  happens to them, on the screen where they hand them over. */
export function ProgressRail({
  current,
  heading,
  body,
  aside,
}: {
  current: number
  heading: React.ReactNode
  body: string
  aside?: { title: string; body: string }
}) {
  return (
    <aside className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-gold">Provider onboarding</p>
        <h2 className="mt-2 text-2xl font-semibold leading-tight">{heading}</h2>
        <p className="mt-3 text-sm text-ink-muted">{body}</p>
      </div>

      <ol className="space-y-2">
        {STEPS.map((step) => {
          const done = step.n < current
          const active = step.n === current
          return (
            <li
              key={step.n}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-card border p-3',
                active ? 'border-gold bg-gold/5' : 'border-line',
              )}
            >
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  done
                    ? 'bg-overlay text-success'
                    : active
                      ? 'bg-gold text-gold-ink'
                      : 'bg-overlay text-ink-muted',
                )}
                aria-hidden
              >
                {done ? '✓' : step.n}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm', active ? 'text-ink' : 'text-ink-secondary')}>
                  {step.title}
                </span>
                <span className="block text-xs text-ink-faint">{step.blurb}</span>
              </span>
            </li>
          )
        })}
      </ol>

      {aside && (
        <div className="rounded-card border border-line p-4">
          <p className="text-xs uppercase tracking-wide text-gold">{aside.title}</p>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">{aside.body}</p>
        </div>
      )}
    </aside>
  )
}

/** Requirement met / not met, mirroring what the server enforces. */
function Requirement({ met, label }: { met: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]',
          met ? 'border-success bg-success/15 text-success' : 'border-line text-ink-faint',
        )}
        aria-hidden
      >
        {met ? '✓' : ''}
      </span>
      {/* The text carries the state too, not just the tick — colour alone is not a signal. */}
      <span className={met ? 'text-ink-secondary' : 'text-ink-muted'}>
        {label}
        <span className="sr-only">{met ? ' — met' : ' — not yet met'}</span>
      </span>
    </li>
  )
}

export function Onboarding({ token, email }: { token: string; email: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // The same list the server enforces, plus the one rule only the form knows about.
  const checks = [
    ...PASSWORD_CHECKS.map((c) => ({ met: c.met(password), label: c.label })),
    { met: password.length > 0 && password === confirm, label: 'Passwords match' },
  ]
  const ready = checks.every((c) => c.met)

  function submit() {
    setError(null)
    start(async () => {
      const result = await activateAccount({ token, password, confirm })
      if (result.error) {
        setError(result.error)
        return
      }
      // Signed in already — straight on to the profile step.
      router.push('/onboarding/profile')
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="w-full max-w-md">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-gold">Step 1 of 6</span>
          <span className="text-xs text-ink-muted">Create Password</span>
        </div>
        <div className="mt-2 h-0.5 w-full rounded bg-line" role="presentation">
          <div className="h-full w-1/6 rounded bg-gold" />
        </div>

        <h1 className="mt-6 text-2xl font-semibold leading-tight">
          Welcome to <span className="text-gold">Melanite</span>.
          <br />
          Let&rsquo;s secure your account.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          You&rsquo;ve been invited to join the Melanite provider network. Set a password to
          activate your account and continue setup.
        </p>

        <div className="mt-6 space-y-4">
          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            readOnly
            hint="This is the address your invite was sent to."
          />

          <Field
            id="password"
            label="Create password"
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />

          <Field
            id="confirm"
            label="Confirm password"
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />

          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show passwords
          </label>

          <ul className="space-y-1.5 rounded-card border border-line p-4">
            {checks.map((check) => (
              <Requirement key={check.label} met={check.met} label={check.label} />
            ))}
          </ul>

          {error && <Notice>{error}</Notice>}

          <Button block onClick={submit} disabled={pending || !ready}>
            {pending ? 'Activating…' : 'Activate account'}
          </Button>
        </div>
      </div>

      <ProgressRail
        current={1}
        heading={
          <>
            You&rsquo;re <span className="text-gold">6 steps</span> away from your first payout.
          </>
        }
        body="This one-time setup takes about 10 minutes. Once complete, you'll have full access to book laser time and accept payments from clients."
      />
    </div>
  )
}
