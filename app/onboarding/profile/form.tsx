'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { PhoneField } from '@/components/ui/validated-field'

import { saveProfile } from '../actions'

export function ProfileForm({
  initial,
}: {
  initial: {
    firstName: string
    lastName: string
    phone: string
    credentials: string
    practiceType: 'laser' | 'room_only'
  }
}) {
  const [firstName, setFirstName] = useState(initial.firstName)
  const [lastName, setLastName] = useState(initial.lastName)
  const [phone, setPhone] = useState(initial.phone)
  const [credentials, setCredentials] = useState(initial.credentials)
  const [practiceType, setPracticeType] = useState<'laser' | 'room_only'>(initial.practiceType)
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

      <PhoneField
        id="phone"
        label="Phone number"
        required
        value={phone}
        onChange={setPhone}
        placeholder="(208) 555-0142"
        hint="Used for booking notifications from Melanite. Not shown publicly, and never given to anybody's client."
      />

      {/* The hint used to say these appear "on client checkout pages". Melanite does not show a
          rental provider's name to anybody's client — it holds no client records at all — so
          that named a page they will never have. */}
      <Field
        id="credentials"
        label="Professional credentials"
        required
        value={credentials}
        onChange={(e) => setCredentials(e.target.value)}
        placeholder="RN, NP, PA, MD, DO, Esthetician, or Other"
        hint="Appears next to your name (e.g. “Jane Doe, RN”) on your Melanite records."
      />

      {/* Asked here because it decides which of the remaining steps apply. A room renter never
          books laser time, so the card on file has nothing to be charged for — and finding that
          out after making them add one would be too late to spare them it.
          
          The old wording said "no Connect account and no laser service menu". Neither exists
          any more: Connect went with the rental model, and the services step with it. */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-secondary">
          How will you be working at Melanite?{' '}
          <span className="text-gold" aria-hidden>
            *
          </span>
        </legend>

        {(
          [
            {
              key: 'laser' as const,
              title: 'Using the laser',
              blurb:
                'You book laser time and pay Melanite a rental fee for each session. You bill your own clients, at your own prices — that side never comes through Melanite.',
            },
            {
              key: 'room_only' as const,
              title: 'Renting the room only',
              blurb:
                'You rent the treatment room by the day and bring your own clients. You bill them yourself and pay for the room out of pocket.',
            },
          ]
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setPracticeType(option.key)}
            aria-pressed={practiceType === option.key}
            className={
              'block w-full rounded-field border px-4 py-3 text-left transition-colors ' +
              (practiceType === option.key
                ? 'border-gold bg-gold/10'
                : 'border-line-control hover:border-line-strong')
            }
          >
            <span
              className={
                'block text-sm font-medium ' +
                (practiceType === option.key ? 'text-gold' : 'text-ink')
              }
            >
              {option.title}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
              {option.blurb}
            </span>
          </button>
        ))}

        <p className="text-xs text-ink-faint">
          Melanite can change this later if what you do here changes.
        </p>
      </fieldset>

      {error && <Notice>{error}</Notice>}

      <Button
        block
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await saveProfile({
              firstName,
              lastName,
              phone,
              credentials,
              practiceType,
            })
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Saving…' : 'Continue to license'}
      </Button>
    </div>
  )
}
