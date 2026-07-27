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
