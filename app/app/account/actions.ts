'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { validatePassword } from '@/lib/auth/reset'
import { destroyOtherSessions } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { isValidPhone } from '@/lib/validation'

export interface AccountState {
  error?: string
  success?: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Profile and license details.
 *
 *  Email is deliberately not editable here: it is the login identity, and changing it needs a
 *  verification round-trip rather than a text box. v1's PATCH /me left it out for the same
 *  reason.
 *
 *  License expiry is editable and matters more than it looks — it is one of the three booking
 *  gates, so a provider correcting a typo here can unblock or block themselves. The form says
 *  so rather than letting that be a surprise.
 */
export async function updateProfile(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const user = await requireProvider()

  const firstName = String(formData.get('firstName') ?? '').trim()
  const lastName = String(formData.get('lastName') ?? '').trim()
  const phone = String(formData.get('phone') ?? '').trim() || null
  const credentials = String(formData.get('credentials') ?? '').trim() || null
  const licenseNumber = String(formData.get('licenseNumber') ?? '').trim() || null
  const licenseState = String(formData.get('licenseState') ?? '').trim() || null
  const licenseExpiryRaw = String(formData.get('licenseExpiry') ?? '').trim()
  const malpracticeInsurance = String(formData.get('malpracticeInsurance') ?? '').trim() || null

  if (!firstName || !lastName) return { error: 'First and last name are required.' }
  if (phone && !isValidPhone(phone)) {
    return { error: 'That phone number doesn’t look right — 10 digits, or leave it blank.' }
  }

  // Onboarding requires the license, so Account must not let it be erased afterwards. Without
  // this the strictness of setup is decorative: finish it, then blank every field.
  //
  // Scoped to providers. An owner or the medical director is not practising under a laser
  // license, and two of those accounts have never had one — requiring it of them would lock
  // them out of their own profile form over a field that does not apply.
  if (user.role === 'provider') {
    if (!licenseNumber) return { error: 'Your license number is required.' }
    if (!licenseState) return { error: 'The state your license was issued in is required.' }
    if (!licenseExpiryRaw) return { error: 'Your license expiry date is required.' }
  }

  if (licenseExpiryRaw && !DATE.test(licenseExpiryRaw)) {
    return { error: 'License expiry must be a valid date.' }
  }

  await db
    .update(providers)
    .set({
      firstName,
      lastName,
      phone,
      credentials,
      licenseNumber,
      licenseState,
      licenseExpiry: licenseExpiryRaw || null,
      malpracticeInsurance,
    })
    .where(eq(providers.id, user.id))

  revalidatePath('/app/account')
  return { success: 'Profile saved.' }
}

/** Notification preferences.
 *
 *  New to the provider in v2. The columns exist in v1 but only PATCH /providers/{id} — the
 *  ADMIN endpoint — writes them, so a provider could not change their own settings; they had
 *  to ask Melanite. */
export async function updateNotifications(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const user = await requireProvider()
  const on = (name: string) => formData.get(name) === 'on'

  await db
    .update(providers)
    .set({
      notifyBookingConfirmed: on('notifyBookingConfirmed'),
      notifyPayoutDeposited: on('notifyPayoutDeposited'),
      notifyAppointmentReminders: on('notifyAppointmentReminders'),
      notifyNewAvailability: on('notifyNewAvailability'),
      notifyMembershipBilling: on('notifyMembershipBilling'),
    })
    .where(eq(providers.id, user.id))

  revalidatePath('/app/account')
  return { success: 'Notification settings saved.' }
}

/** Change password while signed in.
 *
 *  v1 has no such flow — only reset-by-email, which means changing a password you already
 *  know requires losing access to your inbox first. Requires the current password, so a
 *  borrowed unlocked laptop cannot lock the owner out.
 */
export async function changePassword(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const user = await requireProvider()

  const current = String(formData.get('currentPassword') ?? '')
  const next = String(formData.get('newPassword') ?? '')
  const confirm = String(formData.get('confirmPassword') ?? '')

  if (next !== confirm) return { error: 'New passwords do not match.' }

  const problem = validatePassword(next)
  if (problem) return { error: problem }

  const [row] = await db
    .select({ passwordHash: providers.passwordHash })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!row || !(await verifyPassword(current, row.passwordHash))) {
    return { error: 'Your current password is incorrect.' }
  }

  await db
    .update(providers)
    .set({ passwordHash: await hashPassword(next), requiresPasswordReset: false })
    .where(eq(providers.id, user.id))

  // Every other device loses access. The one making the change keeps its session, so the
  // provider is not signed out of the page they are standing on.
  await destroyOtherSessions(user.id)

  revalidatePath('/app/account')
  return {
    success: 'Password changed. You have been signed out on every other device.',
  }
}
