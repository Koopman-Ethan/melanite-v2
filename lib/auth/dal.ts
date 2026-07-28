import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

import { canSeeOversight, isAdmin } from './roles'
import { getSessionUser, type SessionUser } from './session'

// The Data Access Layer. Per the Next 16 authentication guide, `proxy.ts` performs only an
// optimistic cookie check — it must never be the authorization boundary, because it runs on
// prefetches and cannot safely hit the database. Real verification happens here, called from
// the page or layout that actually needs it.
//
// `cache` dedupes within a single render pass, so a layout and its page can both call
// `requireProvider()` without issuing two queries.

export const getCurrentUser = cache(getSessionUser)

/** Any signed-in provider. Redirects to login otherwise. */
export async function requireProvider(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  // Imported accounts have no usable password hash — Xano's is not portable — so they are
  // forced through a reset before reaching anything else.
  //
  // Sent to /forgot-password, not /reset-password: without a token the latter can only say
  // "link expired", which is both wrong and a dead end. This is the page that can actually
  // issue one.
  if (user.requiresPasswordReset) redirect('/forgot-password?forced=1')

  return user
}

/** Admin surfaces. v1 had a `role` enum AND an `is_admin` boolean and gated on different
 *  ones in different places; v2 has only `role`. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireProvider()
  if (!isAdmin(user.role)) redirect('/app')
  return user
}

/** Clinical oversight surfaces. Admits the medical director plus admins — see OVERSIGHT_ROLES
 *  for why that is a separate set rather than a wider definition of admin. */
export async function requireOversight(): Promise<SessionUser> {
  const user = await requireProvider()
  if (!canSeeOversight(user.role)) redirect('/app')
  return user
}

/** THREE booking gates, not two. v1 enforced them partly in page JS and partly per endpoint,
 *  with no single place that answered "may this provider book?" — which is how the license
 *  check gets overlooked: it lives inside POST /bookings/create alongside validation, well
 *  away from the other two.
 *
 *  All must pass:
 *   - `bookingEnabled`         manual admin flip once documents are confirmed on file
 *   - `medicalDirectorStatus`  the credential / subscription gate
 *   - `licenseExpiry`          a lapsed professional license blocks booking outright
 *
 *  Account status is a fourth, handled upstream: getSessionUser() signs out an inactive
 *  provider rather than letting them reach a gate at all. */
export function canBook(user: SessionUser): boolean {
  return (
    user.bookingEnabled &&
    user.medicalDirectorStatus === 'active' &&
    !isLicenseExpired(user)
  )
}

/** Compared as a calendar date in America/Denver, not a timestamp — a license valid "through
 *  the 31st" must not expire at 6pm on the 30th because the server is in UTC. */
export function isLicenseExpired(user: SessionUser): boolean {
  if (!user.licenseExpiry) return false
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  return user.licenseExpiry < today
}

export interface BlockedGate {
  gate: 'booking_enabled' | 'medical_director' | 'license'
  message: string
  /** Where the provider can act on it themselves, if anywhere. Documents and license renewal
   *  both go through Keoni, so those have no self-serve route. */
  href?: string
  action?: string
}

/** EVERY failing gate, not just the first.
 *
 *  Returning one at a time means a provider fixes it, comes back, and discovers another —
 *  which is how a single onboarding problem turns into three support messages. v1 behaved that
 *  way by accident, since each precondition threw on the first failure and the request stopped
 *  there. Showing all of them is a deliberate change.
 */
export function bookingBlockedReasons(user: SessionUser): BlockedGate[] {
  const blocked: BlockedGate[] = []

  if (!user.bookingEnabled) {
    blocked.push({
      gate: 'booking_enabled',
      message:
        'Your account is not yet cleared for booking. Melanite will enable it once your required documents are confirmed.',
    })
  }

  if (user.medicalDirectorStatus !== 'active') {
    const message =
      user.medicalDirectorStatus === 'past_due'
        ? 'Your medical director subscription is past due. Update your billing to resume booking.'
        : user.medicalDirectorStatus === 'inactive'
          ? 'Your medical director coverage is inactive.'
          : 'You need a medical director on file before booking.'

    blocked.push({
      gate: 'medical_director',
      message,
      href: '/app/membership',
      action:
        user.medicalDirectorStatus === 'past_due'
          ? 'Update billing'
          : 'Set up your medical director',
    })
  }

  if (isLicenseExpired(user)) {
    blocked.push({
      gate: 'license',
      message: `Your professional license expired on ${user.licenseExpiry}. Renew it, then contact Melanite to update your record.`,
    })
  }

  return blocked
}

export async function requireBookingAccess(): Promise<SessionUser> {
  const user = await requireProvider()
  if (!canBook(user)) redirect('/app?blocked=booking')
  return user
}
