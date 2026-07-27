import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'

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
  if (!ADMIN_ROLES.has(user.role)) redirect('/app')
  return user
}

const ADMIN_ROLES = new Set<SessionUser['role']>(['platform_owner', 'developer'])

/** THREE booking gates, not two. v1 enforced them partly in page JS and partly per endpoint,
 *  with no single place that answered "may this provider book?" — which is how the licence
 *  check gets overlooked: it lives inside POST /bookings/create alongside validation, well
 *  away from the other two.
 *
 *  All must pass:
 *   - `bookingEnabled`         manual admin flip once documents are confirmed on file
 *   - `medicalDirectorStatus`  the credential / subscription gate
 *   - `licenseExpiry`          a lapsed professional licence blocks booking outright
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

/** Compared as a calendar date in America/Denver, not a timestamp — a licence valid "through
 *  the 31st" must not expire at 6pm on the 30th because the server is in UTC. */
export function isLicenseExpired(user: SessionUser): boolean {
  if (!user.licenseExpiry) return false
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  return user.licenseExpiry < today
}

export function bookingBlockedReason(user: SessionUser): string | null {
  if (!user.bookingEnabled) {
    return 'Your account is not yet cleared for booking. Melanite will enable it once your documents are on file.'
  }
  if (user.medicalDirectorStatus === 'none') {
    return 'You need a medical director on file before booking.'
  }
  if (user.medicalDirectorStatus === 'past_due') {
    return 'Your medical director subscription is past due. Update your billing to resume booking.'
  }
  if (user.medicalDirectorStatus === 'inactive') {
    return 'Your medical director coverage is inactive.'
  }
  if (isLicenseExpired(user)) {
    return 'Your professional license has expired. Renew it and contact Melanite to update your record before booking.'
  }
  return null
}

export async function requireBookingAccess(): Promise<SessionUser> {
  const user = await requireProvider()
  if (!canBook(user)) redirect('/app?blocked=booking')
  return user
}
