import type { SessionUser } from '@/lib/auth/session'

/** Roles permitted to reach `/app/admin/*`.
 *
 *  Deliberately narrower than `isAdminView()` in `lib/nav`: a medical director sees the
 *  platform-shaped sidebar but `requireAdmin()` turns them away at the door. Keeping the two
 *  sets in one file each is what stops the nav from offering a link that only ever bounces.
 *
 *  Type-only import of `SessionUser`, so this stays usable from client components even though
 *  `session.ts` is server-only. */
export const ADMIN_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'platform_owner',
  'developer',
])

export function isAdmin(role: SessionUser['role']): boolean {
  return ADMIN_ROLES.has(role)
}

/** Roles permitted to reach `/app/oversight`.
 *
 *  A third tier, deliberately not a promotion to admin. The medical director signs off on
 *  clinical practice, which is not the same authority as deciding who may take clients or
 *  seeing what the business earns — adding him to ADMIN_ROLES would have handed him Revenue
 *  and the provider toggles along with the calendar he actually needs.
 *
 *  Admins are included because a surface nobody with support access can look at is a surface
 *  nobody can help with. */
export const OVERSIGHT_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'platform_owner',
  'developer',
  'medical_director',
])

export function isMedicalDirector(role: SessionUser['role']): boolean {
  return role === 'medical_director'
}

export function canSeeOversight(role: SessionUser['role']): boolean {
  return OVERSIGHT_ROLES.has(role)
}
