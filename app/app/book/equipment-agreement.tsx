'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/field'
import { acceptEquipmentPolicy } from '@/app/app/appointments/equipment-actions'
import {
  EQUIPMENT_POLICY_CONSEQUENCE,
  EQUIPMENT_POLICY_POINTS,
  EQUIPMENT_POLICY_TITLE,
} from '@/lib/equipment-policy'

/** Shown once, in front of the booking form, to a provider who has not accepted the current
 *  wording.
 *
 *  Deliberately NOT one of the booking gates. Those three say whether somebody may practise at
 *  all; this is a house rule about a shared machine, and conflating the two would mean a wording
 *  change reading as "your account has been suspended".
 *
 *  It is also not a wall of terms with a tick box. Five sentences, the second of which explains
 *  what the provider gets out of it — because nothing here is enforceable and a provider who
 *  thinks it is surveillance simply will not take the photographs. */
export function EquipmentAgreement() {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function accept() {
    setError(null)
    start(async () => {
      const result = await acceptEquipmentPolicy()
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <div className="rounded-card border border-line bg-surface p-6">
      <h2 className="text-base font-medium">{EQUIPMENT_POLICY_TITLE}</h2>
      <p className="mt-1.5 text-sm text-ink-secondary">
        One thing before you book. There is one laser and several people using it, so we keep a
        record of what state it is in when it changes hands.
      </p>

      <ul className="mt-4 space-y-2.5">
        {EQUIPMENT_POLICY_POINTS.map((point) => (
          <li key={point} className="flex gap-2.5 text-sm text-ink-secondary">
            <span aria-hidden className="mt-0.5 text-gold">
              •
            </span>
            <span>{point}</span>
          </li>
        ))}
      </ul>

      <p className="mt-4 rounded-field border border-line bg-overlay p-3 text-xs text-ink-muted">
        {EQUIPMENT_POLICY_CONSEQUENCE}
      </p>

      {error && (
        <div className="mt-4">
          <Notice>{error}</Notice>
        </div>
      )}

      <div className="mt-5">
        <Button onClick={accept} disabled={pending}>
          {pending ? 'Saving…' : 'Got it — let me book'}
        </Button>
      </div>
    </div>
  )
}
