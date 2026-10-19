import { isAdmin, isMedicalDirector } from '@/lib/auth/roles'
import type { SessionUser } from '@/lib/auth/session'
import { paysRent } from '@/lib/revenue-model'

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
  /** Shown only to a provider on the original 50/50 split — Leyla, Brittany and Karly.
   *
   *  These are the client-payment surfaces. They are not legacy: those three bill their clients
   *  through Melanite, so their own price list and their payouts are how they work. For
   *  everybody else the pages exist and mean nothing, which is why they were unlinked rather
   *  than deleted when the rental model arrived. */
  /** Shown only to a provider who pays rent. Charges is empty and misleading for anybody else:
   *  a 50/50 provider is never charged a rental fee, so the page would list nothing for ever. */
  rentalOnly?: boolean
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
  { label: 'Charges', href: '/app/charges', providerOnly: true, rentalOnly: true },
  // ALL FOUR OF THE 12 OCTOBER RESTORATIONS ARE NOW GONE.
  //
  // Packages and Prepaid went with the feature: both were a client paying Melanite in advance,
  // and Melanite no longer takes client money from anybody. Earnings was a link to a page that
  // has never existed — a 404 in three providers' navigation for a week — and there is nothing
  // to earn now that nobody is paid through Melanite.
  //
  // My Services outlived them by five days. It was kept because it held the prices Melanite
  // halved to work out what the three owed; when Keoni decided on 19 October that she would
  // rather read their receipts than track their pricing, the page stopped feeding anything.
  // Leaving it linked would invite them to maintain a price list nothing reads — which is
  // worse than removing it, because the numbers would look like they mattered.
  //
  // THE PAGE ITSELF STILL EXISTS and is reachable by URL. It is only unlinked, which is what
  // `/app/services` has survived twice before; deleting it is a separate decision from
  // deciding nobody needs it in their navigation today.
  { label: 'Daily Room Rental', href: '/app/room-rental', providerOnly: true },
  { label: 'Membership', href: '/app/membership', providerOnly: true },
  { label: 'Calendar', href: '/app/admin/calendar', adminOnly: true },
  { label: 'Equipment', href: '/app/admin/equipment', adminOnly: true },
  { label: 'Providers', href: '/app/admin/providers', adminOnly: true },
  { label: 'Training', href: '/app/admin/training', adminOnly: true },
  { label: 'Queue', href: '/app/admin/queue', adminOnly: true },
  { label: 'Revenue', href: '/app/admin/revenue', adminOnly: true },
  { label: 'Laser Pricing', href: '/app/admin/pricing', adminOnly: true },
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
      // The billing model decides which half of the app exists for somebody. Note these are
      // asked of every role, including the house account: Melanite's own appointments are not
      // rented, so it gets neither set.
      !(item.rentalOnly && !paysRent(user.revenueModel)) &&
      // Dashboard is the director's Oversight page, so listing both is one link too many.
      !(item.label === 'Dashboard' && director),
  ).map((item) => (item.label === 'Dashboard' ? { ...item, href: dashboardHref(user) } : item))
}

/** Marks the active item. Exact match for `/app/dashboard` and `/app/admin` so that a nested
 *  admin route does not also light up Dashboard; prefix match elsewhere so `/app/admin/training/new`
 *  keeps Training highlighted. */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/app/dashboard' || href === '/app/admin') return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}
