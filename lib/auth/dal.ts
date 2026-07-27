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
  if (user.requiresPasswordReset) redirect('/reset-password')

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

/** The two booking gates, which in v1 were enforced partly in page JS and partly per
 *  endpoint, with no single place that answered "may this provider book?".
 *
 *  Both must pass: `medicalDirectorStatus` is the credential/subscription gate, and
 *  `bookingEnabled` is the manual admin flip once documents are confirmed on file. */
export function canBook(user: SessionUser): boolean {
  return user.bookingEnabled && user.medicalDirectorStatus === 'active'
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
  return null
}

export async function requireBookingAccess(): Promise<SessionUser> {
  const user = await requireProvider()
  if (!canBook(user)) redirect('/app?blocked=booking')
  return user
}
