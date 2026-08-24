import { isAdmin, isMedicalDirector } from '@/lib/auth/roles'
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
  /** Hidden from admin-view roles who do not themselves practise. In v1 this was the BUG-15
   *  HIDE array, on the assumption that an admin never books — which stopped being true when
   *  the platform owner started treating her own clients. See `practises`. */
  providerOnly?: boolean
  /** Shown only to the medical director. His surfaces are neither provider nor admin. */
  directorOnly?: boolean
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

/** Does this person treat clients, whatever else they are?
 *
 *  Keyed on `bookingEnabled` rather than on a role or on `revenueModel`. The question the nav
 *  is asking is "do they need the booking surfaces", and that is what the flag Keoni already
 *  flips to let somebody book means — no new concept, and nothing to keep in step.
 *
 *  It deliberately reads the flag rather than `canBook`: an admin blocked by a DIFFERENT gate
 *  still needs the Book link, because the page behind it is the one that explains why they are
 *  blocked. Hiding it would leave them with no route to the explanation. */
export function practises(user: SessionUser): boolean {
  return user.bookingEnabled
}

/** Dashboard is the one item whose destination depends on who you are — v1 expressed this as
 *  a `dashTarget` function inside the MAP.
 *
 *  The medical director gets his own home, and it is not optional. He counts as an admin VIEW
 *  (so the provider items are hidden) but not as an admin (so `requireAdmin` turns him away),
 *  which sent him to /app/admin, which redirected to /app, which sent him to /app/admin. He
 *  could not sign in at all — the browser gave up after ~70 redirects. */
export function dashboardHref(user: SessionUser): string {
  if (isMedicalDirector(user.role)) return '/app/oversight'
  return isAdminView(user) ? '/app/admin' : '/app/dashboard'
}

const ITEMS: NavItem[] = [
  { label: 'Book Laser Time', href: '/app/book', providerOnly: true },
  { label: 'Dashboard', href: '/app/dashboard' },
  { label: 'Appointments', href: '/app/appointments', providerOnly: true },
  { label: 'Earnings', href: '/app/earnings', providerOnly: true },
  { label: 'Packages', href: '/app/packages', providerOnly: true },
  { label: 'Prepaid', href: '/app/prepaid', providerOnly: true },
  { label: 'Daily Room Rental', href: '/app/room-rental', providerOnly: true },
  { label: 'My Services', href: '/app/services', providerOnly: true },
  { label: 'Membership', href: '/app/membership', providerOnly: true },
  { label: 'Calendar', href: '/app/admin/calendar', adminOnly: true },
  { label: 'Providers', href: '/app/admin/providers', adminOnly: true },
  { label: 'Training', href: '/app/admin/training', adminOnly: true },
  { label: 'Queue', href: '/app/admin/queue', adminOnly: true },
  { label: 'Revenue', href: '/app/admin/revenue', adminOnly: true },
  { label: 'Tools', href: '/app/admin/tools', adminOnly: true },
  { label: 'Oversight', href: '/app/oversight', directorOnly: true },
  { label: 'Account', href: '/app/account' },
]

export function navFor(user: SessionUser): NavItem[] {
  const adminView = isAdminView(user)
  const admin = isAdmin(user.role)
  const director = isMedicalDirector(user.role)

  return ITEMS.filter(
    (item) =>
      !(item.providerOnly && adminView && !practises(user)) &&
      !(item.adminOnly && !admin) &&
      !(item.directorOnly && !director) &&
      // Dashboard is the director's Oversight page, so listing both is one link too many.
      !(item.label === 'Dashboard' && director),
  ).map((item) => (item.label === 'Dashboard' ? { ...item, href: dashboardHref(user) } : item))
}

/** Marks the active item. Exact match for `/app/dashboard` and `/app/admin` so that a nested
 *  admin route does not also light up Dashboard; prefix match elsewhere so `/app/packages/new`
 *  keeps Packages highlighted. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/app/dashboard' || href === '/app/admin') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}
