'use client'

import { useActionState, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { saveMedicalDirector, type DirectorState } from './actions'

export interface DirectorValues {
  name: string
  credentials: string | null
  npi: string | null
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  contactEmail: string | null
  contactPhone: string | null
}

/**
 * Where a provider records the director who supervises her.
 *
 * Only the name is required. Everything else is optional on purpose: a provider halfway through
 * onboarding, standing in front of a booking gate, may not have her director's NPI to hand — and
 * a form that refuses everything until she does is a form she abandons, leaving Melanite with
 * nothing at all instead of a name and a phone number. She can come back and fill in the rest.
 *
 * Saving does not open the gate, and the form says so rather than letting her discover it by
 * still being blocked afterwards.
 */
export function DirectorForm({
  existing,
  status,
}: {
  existing: DirectorValues | null
  status: 'none' | 'active' | 'past_due' | 'inactive'
}) {
  const [state, action, pending] = useActionState<DirectorState, FormData>(
    saveMedicalDirector,
    {},
  )
  const [open, setOpen] = useState(existing === null)

  if (!open) {
    return (
      <div className="mt-4">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Edit these details
        </Button>
        {state.success && <p className="mt-2 text-xs text-success">{state.success}</p>}
      </div>
    )
  }

  return (
    <form action={action} className="mt-4 space-y-4">
      <Field
        label="Your medical director’s name"
        id="md-name"
        name="name"
        required
        defaultValue={existing?.name ?? ''}
        placeholder="Dr Jane Smith"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Their credentials"
          id="md-credentials"
          name="credentials"
          defaultValue={existing?.credentials ?? ''}
          placeholder="MD, DO, NP"
        />
        <Field
          label="NPI"
          id="md-npi"
          name="npi"
          inputMode="numeric"
          defaultValue={existing?.npi ?? ''}
          placeholder="10 digits"
        />
        <Field
          label="Their license number"
          id="md-licenseNumber"
          name="licenseNumber"
          defaultValue={existing?.licenseNumber ?? ''}
        />
        <Field
          label="Issued in"
          id="md-licenseState"
          name="licenseState"
          defaultValue={existing?.licenseState ?? ''}
          placeholder="Idaho"
        />
        <Field
          label="Their license expires"
          id="md-licenseExpiry"
          name="licenseExpiry"
          type="date"
          defaultValue={existing?.licenseExpiry ?? ''}
        />
        <Field
          label="Their email"
          id="md-contactEmail"
          name="contactEmail"
          type="email"
          defaultValue={existing?.contactEmail ?? ''}
        />
        <Field
          label="Their phone"
          id="md-contactPhone"
          name="contactPhone"
          type="tel"
          defaultValue={existing?.contactPhone ?? ''}
        />
      </div>

      {state.error && <Notice>{state.error}</Notice>}
      {state.success && <Notice tone="success">{state.success}</Notice>}

      <p className="text-xs text-ink-faint">
        {status === 'active'
          ? 'Melanite will be told these details changed. Your booking access is not affected.'
          : 'Melanite checks this against your signed supervision agreement before opening booking. Saving it here does not open booking on its own.'}
      </p>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : existing ? 'Save changes' : 'Save my director'}
        </Button>
        {existing && (
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
