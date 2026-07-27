'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { saveProfile } from '../actions'

export function ProfileForm({
  initial,
}: {
  initial: { firstName: string; lastName: string; phone: string; credentials: string }
}) {
  const [firstName, setFirstName] = useState(initial.firstName)
  const [lastName, setLastName] = useState(initial.lastName)
  const [phone, setPhone] = useState(initial.phone)
  const [credentials, setCredentials] = useState(initial.credentials)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          Tell us a bit <span className="text-gold">about you</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Your name and credentials appear on client-facing checkout pages, so they know who
          is treating them.
        </p>
      </div>

      <p className="text-xs text-ink-faint">
        Every field is required.{' '}
        <span className="text-gold" aria-hidden>
          *
        </span>
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="firstName"
          label="First name"
          required
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoComplete="given-name"
        />
        <Field
          id="lastName"
          label="Last name"
          required
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
        />
      </div>

      <Field
        id="phone"
        label="Phone number"
        required
        type="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        autoComplete="tel"
        placeholder="(208) 555-0142"
        hint="Used for booking notifications and client messages. Not shown publicly."
      />

      <Field
        id="credentials"
        label="Professional credentials"
        required
        value={credentials}
        onChange={(e) => setCredentials(e.target.value)}
        placeholder="RN, NP, PA, MD, DO, Esthetician, or Other"
        hint="Appears next to your name (e.g. “Jane Doe, RN”) on client checkout pages."
      />

      {error && <Notice>{error}</Notice>}

      <Button
        block
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await saveProfile({ firstName, lastName, phone, credentials })
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Saving…' : 'Continue to licence'}
      </Button>
    </div>
  )
}
