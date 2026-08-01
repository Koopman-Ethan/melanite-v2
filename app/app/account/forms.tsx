'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'
import { Field, Notice } from '@/components/ui/field'
import { PhoneField } from '@/components/ui/validated-field'
import { todayInDenver } from '@/lib/validation'

import {
  changePassword,
  updateNotifications,
  updateProfile,
  type AccountState,
} from './actions'

function Save({ label = 'Save changes' }: { label?: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

function Result({ state }: { state: AccountState }) {
  if (state.error) return <Notice>{state.error}</Notice>
  if (state.success) return <Notice tone="success">{state.success}</Notice>
  return null
}

export interface ProfileValues {
  firstName: string
  lastName: string
  phone: string | null
  credentials: string | null
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  malpracticeInsurance: string | null
}

export function ProfileForm({
  values,
  licenseRequired,
}: {
  values: ProfileValues
  /** Providers practise under the license, so they cannot blank it. Owners and the medical
   *  director are not practising under one and two of those accounts have never had one. */
  licenseRequired: boolean
}) {
  const [state, action] = useActionState<AccountState, FormData>(updateProfile, {})

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="firstName" name="firstName" label="First name" defaultValue={values.firstName} required />
        <Field id="lastName" name="lastName" label="Last name" defaultValue={values.lastName} required />
        <PhoneField id="phone" name="phone" label="Phone" defaultValue={values.phone ?? ''} optional />
        <Field
          id="credentials"
          name="credentials"
          label="Credentials"
          defaultValue={values.credentials ?? ''}
          hint="e.g. RN, NP, Esthetician"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="licenseNumber"
          name="licenseNumber"
          label="License number"
          defaultValue={values.licenseNumber ?? ''}
          required={licenseRequired}
        />
        <Field
          id="licenseState"
          name="licenseState"
          label="License state"
          defaultValue={values.licenseState ?? ''}
          required={licenseRequired}
        />
        <Field
          id="licenseExpiry"
          name="licenseExpiry"
          label="License expires"
          type="date"
          min={todayInDenver()}
          defaultValue={values.licenseExpiry ?? ''}
          required={licenseRequired}
          hint="Booking stops automatically once this date passes."
        />
        <Field
          id="malpracticeInsurance"
          name="malpracticeInsurance"
          label="Malpractice insurance"
          defaultValue={values.malpracticeInsurance ?? ''}
        />
      </div>

      <Result state={state} />
      <Save />
    </form>
  )
}

export interface NotificationValues {
  notifyBookingConfirmed: boolean
  notifyPayoutDeposited: boolean
  notifyAppointmentReminders: boolean
  notifyNewAvailability: boolean
  notifyMembershipBilling: boolean
}

const NOTIFICATIONS: Array<{ name: keyof NotificationValues; label: string; hint: string }> = [
  {
    name: 'notifyBookingConfirmed',
    label: 'Payment received',
    hint: 'When a client pays through your checkout link',
  },
  {
    name: 'notifyPayoutDeposited',
    label: 'Payout deposited',
    hint: 'When Stripe sends money to your bank',
  },
  {
    name: 'notifyAppointmentReminders',
    label: 'Appointment reminders',
    hint: '24 hours before each booking',
  },
  {
    name: 'notifyNewAvailability',
    label: 'New laser availability',
    hint: 'When time opens up on the shared calendar',
  },
  {
    name: 'notifyMembershipBilling',
    label: 'Membership billing',
    hint: 'Medical director receipts and billing reminders',
  },
]

export function NotificationsForm({ values }: { values: NotificationValues }) {
  const [state, action] = useActionState<AccountState, FormData>(updateNotifications, {})

  return (
    <form action={action} className="space-y-4">
      <ul className="divide-y divide-line rounded-card border border-line">
        {NOTIFICATIONS.map((n) => (
          <li key={n.name} className="flex items-start gap-3 p-4">
            <input
              id={n.name}
              name={n.name}
              type="checkbox"
              defaultChecked={values[n.name]}
              className="mt-0.5 size-4 accent-[var(--color-gold)]"
            />
            <label htmlFor={n.name} className="min-w-0 cursor-pointer">
              <span className="block text-sm text-ink-secondary">{n.label}</span>
              <span className="block text-xs text-ink-faint">{n.hint}</span>
            </label>
          </li>
        ))}
      </ul>

      <Result state={state} />
      <Save label="Save preferences" />
    </form>
  )
}

export function PasswordForm() {
  const [state, action] = useActionState<AccountState, FormData>(changePassword, {})

  return (
    <form action={action} className="space-y-4">
      <Field
        id="currentPassword"
        name="currentPassword"
        type="password"
        label="Current password"
        autoComplete="current-password"
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="newPassword"
          name="newPassword"
          type="password"
          label="New password"
          autoComplete="new-password"
          minLength={12}
          required
          hint="At least 12 characters, with a letter and a number."
        />
        <Field
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          label="Confirm new password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>

      <Result state={state} />
      <Save label="Change password" />
    </form>
  )
}
