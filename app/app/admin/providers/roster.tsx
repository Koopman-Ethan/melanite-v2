'use client'

import { useOptimistic, useState, useTransition } from 'react'

import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { licenseStatus, type LicenseStatus } from '@/lib/license'

import { setProviderAccess, type ToggleState } from './actions'

export interface RosterView {
  id: string
  firstName: string
  lastName: string
  email: string
  role: string
  status: string
  bookingEnabled: boolean
  roomRentalEnabled: boolean
  licenseExpiry: string | null
  medicalDirectorType: string | null
  medicalDirectorStatus: string
  stripeConnected: boolean
  payoutsEnabled: boolean
}

/** A readiness signal, stated in words as well as colour. */
function Signal({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-xs">
      <span className={ok ? 'text-success' : 'text-warning'} aria-hidden>
        {ok ? '✓' : '!'}
      </span>
      <span className="text-ink-muted">
        {label}: <span className="text-ink-secondary">{detail}</span>
      </span>
    </span>
  )
}

function licenseDetail(status: LicenseStatus, expiry: string | null): string {
  switch (status.state) {
    case 'missing':
      return 'none on file'
    case 'expired':
      return `expired ${expiry}`
    case 'expiring':
      return `${status.daysLeft} days left`
    default:
      return expiry ?? '—'
  }
}

function Toggle({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean
  disabled: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={on ? 'text-ink' : 'text-ink-muted'}>{label}</span>
    </label>
  )
}

export function Roster({
  rows,
  roomRentalGloballyOn,
}: {
  rows: RosterView[]
  roomRentalGloballyOn: boolean
}) {
  const [state, setState] = useState<ToggleState | null>(null)
  const [, start] = useTransition()

  // The toggle moves on click, not when the server gets back.
  //
  // Rendered straight from server state it sat still until the round trip finished, which reads
  // as a switch that does not work — and is exactly what someone clicks a second time. If the
  // action is refused, the optimistic value is dropped when the transition ends and the real
  // one reappears alongside the reason.
  const [shown, applyOptimistic] = useOptimistic(
    rows,
    (current, patch: { id: string; field: 'bookingEnabled' | 'roomRentalEnabled'; value: boolean }) =>
      current.map((row) => (row.id === patch.id ? { ...row, [patch.field]: patch.value } : row)),
  )

  const flip = (providerId: string, field: 'bookingEnabled' | 'roomRentalEnabled', value: boolean) =>
    start(async () => {
      applyOptimistic({ id: providerId, field, value })
      setState(await setProviderAccess({ providerId, field, value }))
    })

  return (
    <div className="space-y-4">
      {!roomRentalGloballyOn && (
        // The trap worth naming: there are two columns called `room_rental_enabled`, on
        // different tables, defaulting opposite ways. Turning a person on while the platform
        // switch is off does nothing, and nothing else in the app says so.
        <Notice tone="warning">
          Room rental is switched off platform-wide, so the per-provider toggles below have no
          effect until that changes.
        </Notice>
      )}

      {state?.error && <Notice>{state.error}</Notice>}
      {state?.success && <Notice tone="success">{state.success}</Notice>}

      <ul className="space-y-3">
        {shown.map((provider) => {
          const license = licenseStatus(provider.licenseExpiry)
          const setupIncomplete = provider.status === 'pending'

          return (
            <li
              key={provider.id}
              className={cn(
                'rounded-card border p-4',
                setupIncomplete ? 'border-dashed border-line' : 'border-line',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium">
                    {provider.firstName} {provider.lastName}
                  </span>
                  <span className="ml-2 text-xs text-ink-faint">{provider.email}</span>
                </div>
                <span className="text-xs text-ink-muted">
                  {provider.role.replace(/_/g, ' ')}
                  {setupIncomplete && ' · still in setup'}
                </span>
              </div>

              {/* Context before controls. The flip is a judgement about whether someone is
                  ready to take clients, and making it blind is how a provider ends up bookable
                  with a lapsed license. */}
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                <Signal
                  ok={license.state === 'ok'}
                  label="License"
                  detail={licenseDetail(license, provider.licenseExpiry)}
                />
                <Signal
                  ok={provider.medicalDirectorStatus === 'active'}
                  label="Medical director"
                  detail={
                    provider.medicalDirectorType === 'own'
                      ? `own (${provider.medicalDirectorStatus})`
                      : provider.medicalDirectorStatus
                  }
                />
                <Signal
                  ok={provider.payoutsEnabled}
                  label="Payouts"
                  detail={
                    !provider.stripeConnected
                      ? 'no Stripe account'
                      : provider.payoutsEnabled
                        ? 'enabled'
                        : 'Stripe still verifying'
                  }
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-6 border-t border-line pt-2">
                <Toggle
                  on={provider.bookingEnabled}
                  disabled={setupIncomplete}
                  label="Can book clients"
                  onChange={(next) => flip(provider.id, 'bookingEnabled', next)}
                />
                <Toggle
                  on={provider.roomRentalEnabled}
                  disabled={false}
                  label="Can rent the room"
                  onChange={(next) => flip(provider.id, 'roomRentalEnabled', next)}
                />
              </div>

              {/* Only an EXPIRED license blocks. An expiring one still works, and a missing
                  one passes the gate entirely — `isLicenseExpired` reads a null as not-expired.
                  Saying "the gate will block them" for either would be plainly false, and a
                  warning that is wrong twice out of three times is one nobody reads. */}
              {provider.bookingEnabled && license.state === 'expired' && (
                <p className="mt-2 text-xs text-warning">
                  Booking is on, but the license expired — the license gate blocks them
                  regardless of this toggle.
                </p>
              )}
              {provider.bookingEnabled && license.state === 'missing' && (
                <p className="mt-2 text-xs text-warning">
                  Booking is on with no license on file. Nothing stops them: the license gate
                  treats a missing date as valid.
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
