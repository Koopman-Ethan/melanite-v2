import { isAdmin } from '@/lib/auth/roles'
import type { SessionUser } from '@/lib/auth/session'

// The provider sidebar, ported from v1's nav wiring.
//
// v1 kept this in three places that had to agree: a `MAP` of label -> href, a `HIDE` list of
// provider-only labels, and the sidebar markup itself — which was static and duplicated
// across five variants (.bksb, .db-sidebar, .er-sb, .appt-sidebar, .adm-sidebar), so adding
// one item meant editing every /app page. This is that model in one place.
//
// The gate also moves. v1 rendered every item and then hid the provider-only ones with JS
// once `__melGetMe()` resolved, so an admin saw a flash of links they cannot use. Roles are
// known on the server here, so unavailable items are never sent.

export interface NavItem {
  label: string
  href: string
  /** Hidden from admin-view roles. In v1 this was the BUG-15 HIDE array — an admin does not
   *  book, has no earnings, and holds no membership, so those surfaces are noise. */
  providerOnly?: boolean
  /** Shown only to roles `requireAdmin()` actually admits. Gated on that same set rather than
   *  on `isAdminView`, which is wider — a medical director sees the platform nav but would be
   *  redirected straight back out of these. */
  adminOnly?: boolean
}

/** Roles that see the platform rather than their own practice. Matches v1's "admin-view
 *  roles (owner/developer/MD/legacy is_admin)". */
const ADMIN_VIEW_ROLES = new Set<SessionUser['role']>([
  'platform_owner',
  'developer',
  'medical_director',
])

export function isAdminView(user: SessionUser): boolean {
  return ADMIN_VIEW_ROLES.has(user.role)
}

/** Dashboard is the one item whose destination depends on who you are — v1 expressed this as
 *  a `dashTarget` function inside the MAP. */
export function dashboardHref(user: SessionUser): string {
  return isAdminView(user) ? '/app/admin' : '/app/dashboard'
}

const ITEMS: NavItem[] = [
  { label: 'Book Laser Time', href: '/app/book', providerOnly: true },
  { label: 'Dashboard', href: '/app/dashboard' },
  { label: 'Appointments', href: '/app/appointments', providerOnly: true },
  { label: 'Earnings', href: '/app/earnings', providerOnly: true },
  { label: 'Packages', href: '/app/packages', providerOnly: true },
  { label: 'Daily Room Rental', href: '/app/room-rental', providerOnly: true },
  { label: 'My Services', href: '/app/services', providerOnly: true },
  { label: 'Membership', href: '/app/membership', providerOnly: true },
  { label: 'Calendar', href: '/app/admin/calendar', adminOnly: true },
  { label: 'Revenue', href: '/app/admin/revenue', adminOnly: true },
  { label: 'Tools', href: '/app/admin/tools', adminOnly: true },
  { label: 'Account', href: '/app/account' },
]

export function navFor(user: SessionUser): NavItem[] {
  const adminView = isAdminView(user)
  const admin = isAdmin(user.role)

  return ITEMS.filter(
    (item) => !(item.providerOnly && adminView) && !(item.adminOnly && !admin),
  ).map((item) => (item.label === 'Dashboard' ? { ...item, href: dashboardHref(user) } : item))
}

/** Marks the active item. Exact match for `/app/dashboard` and `/app/admin` so that a nested
 *  admin route does not also light up Dashboard; prefix match elsewhere so `/app/packages/new`
 *  keeps Packages highlighted. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/app/dashboard' || href === '/app/admin') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}
