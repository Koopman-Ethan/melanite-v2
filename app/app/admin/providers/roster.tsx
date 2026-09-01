'use client'

import { useOptimistic, useState, useTransition } from 'react'

import { Notice } from '@/components/ui/field'
import { cn } from '@/lib/cn'
import { licenseStatus, type LicenseStatus } from '@/lib/license'
import { requiresMedicalDirection, supervisedLabels } from '@/lib/room-procedures'

import {
  setMedicalDirectorConfirmed,
  setPracticeType,
  setProviderAccess,
  type ToggleState,
} from './actions'

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
  practiceType: string
  roomProcedures: string[] | null
  /** Whether they were ASKED, not what they answered. `[]` alone cannot tell the two apart. */
  declared: boolean
  stripeConnected: boolean
  payoutsEnabled: boolean
  /** What the provider filed about her own director, on the `own` path. Null when she has filed
   *  nothing, and on the Melanite plan where the director is Melanite's. */
  director: {
    name: string
    credentials: string | null
    npi: string | null
    licenseNumber: string | null
    licenseState: string | null
    licenseExpiry: string | null
    contactEmail: string | null
    contactPhone: string | null
  } | null
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

  // Not optimistic either, and for a sharper reason than `move`: this is the clinical gate. A
  // toggle that slid to "confirmed" and then failed on the server would leave Melanite believing
  // she had accepted a supervision arrangement she had not.
  const confirmDirector = (providerId: string, confirmed: boolean) =>
    start(async () => {
      setState(await setMedicalDirectorConfirmed({ providerId, confirmed }))
    })

  // Not optimistic. Moving somebody to the laser can send their account back into setup, and a
  // row that rearranged itself before the server agreed would be showing a state that might not
  // survive the round trip.
  const move = (providerId: string, practiceType: 'laser' | 'room_only') =>
    start(async () => {
      setState(await setPracticeType({ providerId, practiceType }))
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

          // Somebody who only rents the room. They never touch the laser and Melanite never
          // handles their client money, so most of this row means something different for them.
          const roomOnly = provider.practiceType === 'room_only'
          const supervised = supervisedLabels(provider.roomProcedures)
          const needsDirector = roomOnly
            ? requiresMedicalDirection(provider.roomProcedures)
            : true
          const directorOnFile = provider.medicalDirectorStatus === 'active'

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
                  {roomOnly && <span className="text-gold">room only · </span>}
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
                  ok={directorOnFile || !needsDirector}
                  label="Medical director"
                  detail={
                    !needsDirector
                      ? 'not required'
                      : provider.medicalDirectorType === 'own'
                        ? `own (${provider.medicalDirectorStatus})`
                        : provider.medicalDirectorStatus
                  }
                />

                {/* Everything she filed about her director, so the decision below can be made
                    from the roster rather than by opening a database. A name and a licence are
                    what make "she has a director" checkable against a state register. */}
                {provider.director && (
                  <div className="basis-full rounded-field border border-line bg-overlay p-3">
                    <p className="text-xs text-ink-secondary">
                      {provider.director.name}
                      {provider.director.credentials && (
                        <span className="text-ink-muted">, {provider.director.credentials}</span>
                      )}
                    </p>
                    <p className="mt-1 text-[11px] text-ink-faint tabular-nums">
                      {[
                        provider.director.npi && `NPI ${provider.director.npi}`,
                        provider.director.licenseNumber &&
                          `License ${provider.director.licenseNumber}${
                            provider.director.licenseState
                              ? ` (${provider.director.licenseState})`
                              : ''
                          }`,
                        provider.director.licenseExpiry &&
                          `expires ${provider.director.licenseExpiry}`,
                        provider.director.contactEmail,
                        provider.director.contactPhone,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No other details given.'}
                    </p>
                  </div>
                )}

                {/* What they said they would be doing in that room. Melanite cannot see inside
                    it, so this declaration is the only basis for the toggle below — and a
                    toggle whose reason is invisible is one that gets flipped back on. */}
                {roomOnly && (
                  <Signal
                    ok={provider.declared && !needsDirector}
                    label="Performs"
                    detail={
                      !provider.declared
                        ? 'never asked'
                        : supervised.length > 0
                          ? supervised.join(', ').toLowerCase()
                          : 'nothing needing supervision'
                    }
                  />
                )}

                {/* Payouts are the rail for a provider's share of what a CLIENT paid Melanite.
                    A room renter has no share, so an empty Connect account is the correct state
                    rather than an outstanding task. */}
                {!roomOnly && (
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
                )}
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

                {/* Own-director path only. On the Melanite plan this column belongs to Stripe,
                    and a hand-set value would be overwritten at the next billing event while
                    meanwhile asserting a subscription nobody is paying for. */}
                {provider.medicalDirectorType === 'own' && (
                  <Toggle
                    on={provider.medicalDirectorStatus === 'active'}
                    disabled={!provider.director}
                    label="Director confirmed"
                    onChange={(next) => confirmDirector(provider.id, next)}
                  />
                )}

                {/* People change what they do. This exists so that never means a database
                    edit — the reason the column was added rather than inferred. */}
                <button
                  type="button"
                  onClick={() => move(provider.id, roomOnly ? 'laser' : 'room_only')}
                  className="ml-auto text-xs text-ink-muted underline decoration-line-control underline-offset-4 hover:text-ink"
                >
                  {roomOnly ? 'Move to laser' : 'Move to room only'}
                </button>
              </div>

              {/* Expired and missing BOTH block now — `hasCurrentLicense` treats a null expiry
                  as no licence rather than as a valid one. An expiring licence still works, so
                  it is deliberately not warned about here; a warning that fires when nothing is
                  wrong is one nobody reads. */}
              {provider.bookingEnabled && license.state === 'expired' && (
                <p className="mt-2 text-xs text-warning">
                  Booking is on, but the license expired — the license gate blocks them
                  regardless of this toggle.
                </p>
              )}
              {provider.bookingEnabled && license.state === 'missing' && (
                <p className="mt-2 text-xs text-warning">
                  Booking is on but there is no license on file, so the license gate blocks them
                  regardless of this toggle. They need to add it on their account.
                </p>
              )}

              {/* The one that matters most, because the toggle above will happily undo it.
                  Onboarding turns room rental off when somebody declares a supervised
                  procedure; without this line, turning it back on looks like fixing a glitch
                  rather than permitting unsupervised injections. */}
              {roomOnly && needsDirector && !directorOnFile && (
                <p className="mt-2 text-xs text-warning">
                  {provider.roomRentalEnabled ? 'Room rental is on, but they' : 'They'} declared{' '}
                  {supervised.join(', ').toLowerCase()} with no medical director on file. Melanite
                  owns the room, so it carries the consequence — get a director on file before
                  {provider.roomRentalEnabled ? ' leaving this on' : ' turning this on'}.
                </p>
              )}

              {/* Not a warning. They finished setup without being asked, which only happens to
                  the providers imported from v1 — the question did not exist then. */}
              {roomOnly && !provider.declared && !setupIncomplete && (
                <p className="mt-2 text-xs text-ink-muted">
                  Never asked what they perform in the room — this account predates the question.
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
