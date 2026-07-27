'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'

import { saveLicense } from '../actions'

const CONTACT = 'melanitelasersuite@gmail.com'

export function LicenseForm({
  initial,
}: {
  initial: {
    licenseNumber: string
    licenseState: string
    licenseExpiry: string
    malpracticeInsurance: string
  }
}) {
  const [licenseNumber, setLicenseNumber] = useState(initial.licenseNumber)
  const [licenseState, setLicenseState] = useState(initial.licenseState)
  const [licenseExpiry, setLicenseExpiry] = useState(initial.licenseExpiry)
  const [malpracticeInsurance, setMalpractice] = useState(initial.malpracticeInsurance)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">
          Verify your <span className="text-gold">credentials</span>.
        </h1>
        <p className="mt-3 text-sm text-ink-muted">
          Your state licence number — not your title. Required for compliance and platform
          records. Once submitted, licence details can only be changed by Melanite.
        </p>
      </div>

      <Field
        id="licenseNumber"
        label="Licence number"
        value={licenseNumber}
        onChange={(e) => setLicenseNumber(e.target.value)}
        placeholder="e.g. RN-123456"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="licenseState"
          label="Licence state"
          value={licenseState}
          onChange={(e) => setLicenseState(e.target.value)}
          placeholder="Idaho, Utah, Oregon, Washington"
        />
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium text-ink-secondary">Licence expiry</span>
          <input
            type="date"
            value={licenseExpiry}
            onChange={(e) => setLicenseExpiry(e.target.value)}
            className="min-h-11 w-full rounded-field border border-line-control bg-surface px-3 py-2 text-sm text-ink focus:border-gold"
          />
        </label>
      </div>

      <Field
        id="malpractice"
        label="Malpractice insurance provider"
        value={malpracticeInsurance}
        onChange={(e) => setMalpractice(e.target.value)}
        placeholder="e.g. NSO, CM&F, Proliability"
      />

      {/* Said here rather than at the end: this is the step where someone is thinking about
          their paperwork, and it is the thing that actually blocks them from taking clients. */}
      <div className="rounded-field border border-warning/40 bg-warning/10 p-3 text-xs text-ink-secondary">
        <strong className="text-warning">Documents required.</strong> Email your malpractice
        insurance documentation to{' '}
        <a href={`mailto:${CONTACT}`} className="text-gold underline underline-offset-4">
          {CONTACT}
        </a>
        . Melanite confirms it before you can book clients — finishing setup here does not
        unlock booking on its own.
      </div>

      {error && <Notice>{error}</Notice>}

      <Button
        block
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await saveLicense({
              licenseNumber,
              licenseState,
              licenseExpiry,
              malpracticeInsurance,
            })
            if (result?.error) setError(result.error)
          })
        }
      >
        {pending ? 'Saving…' : 'Continue to Stripe'}
      </Button>
    </div>
  )
}
