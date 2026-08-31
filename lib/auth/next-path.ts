// Where a person may be sent after signing in.
//
// The proxy records the page somebody was trying to reach and hands it to /login as `next`, so
// they land where they were going rather than on a generic dashboard. The login action then
// checked only that `next` was relative — which stops an open redirect, and stops nothing else.
//
// A relative path that does not EXIST passes that check happily. Leyla hit exactly this on
// 3 August 2026: an old bookmark to v1's `/app/login`, which v2 does not have (login is at
// `/login`). The proxy protects everything under `/app/`, so she was sent to
// `/login?next=%2Fapp%2Flogin`, signed in successfully, and was then redirected to a page that
// does not exist. She saw a bare 404 and reasonably reported it as "it won't let me get in" —
// when in fact she was already in.
//
// So `next` is now checked against real destinations, and anything unrecognised falls back to
// `/app`. Falling back is always safe: the worst outcome is landing on the dashboard instead of
// the page you wanted, which is what happened before this feature existed at all.

/** The prefixes `proxy.ts` protects. Every one of them can produce a `next`, so every one of
 *  them needs its pages listed below. Kept beside the list so the two are read together —
 *  the first version of this file covered `/app` only, and silently sent anybody signing in
 *  mid-onboarding to the dashboard instead of their next step. */
export const PROTECTED_ROOTS: readonly string[] = ['/app', '/onboarding']

/** Every page a signed-in provider may be returned to.
 *
 *  Kept in sync by `test/next-path.test.ts`, which walks each protected root and fails if a
 *  route exists that is not listed here — otherwise this list rots quietly and new pages
 *  silently become un-returnable. */
export const APP_DESTINATIONS: readonly string[] = [
  '/app',
  '/app/account',
  '/app/admin',
  '/app/admin/calendar',
  '/app/admin/equipment',
  '/app/admin/providers',
  '/app/admin/queue',
  '/app/admin/revenue',
  '/app/admin/tools',
  '/app/admin/training',
  '/app/appointments',
  '/app/book',
  '/app/dashboard',
  '/app/earnings',
  '/app/membership',
  '/app/oversight',
  '/app/packages',
  '/app/prepaid',
  '/app/room-rental',
  '/app/services',
  '/onboarding',
  '/onboarding/director',
  '/onboarding/done',
  '/onboarding/license',
  '/onboarding/profile',
  '/onboarding/services',
  '/onboarding/stripe',
] as const

/** Routes with a dynamic segment, matched by prefix rather than exactly. */
const DYNAMIC_PREFIXES: readonly string[] = ['/app/admin/training/']

/**
 * The path to send somebody to after signing in, given whatever arrived as `next`.
 *
 * Returns `/app` for anything unrecognised — including the v1 paths that Webflow's catch-all
 * still forwards, which is the whole reason this exists.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/app'

  // Open-redirect guards, unchanged in intent. `//host` is protocol-relative and would leave
  // the site; a backslash is treated as a slash by some browsers, so it counts as one here.
  const path = next.trim()
  if (!path.startsWith('/')) return '/app'
  if (path.startsWith('//') || path.startsWith('/\\')) return '/app'
  if (path.includes('\\')) return '/app'

  // Query strings and fragments are dropped rather than rejected: `?next=/app/book?x=1` should
  // still return somebody to the booking page, and nothing downstream reads those parameters.
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/app'

  if (APP_DESTINATIONS.includes(clean)) return clean
  if (DYNAMIC_PREFIXES.some((prefix) => clean.startsWith(prefix) && clean.length > prefix.length)) {
    return clean
  }

  return '/app'
}
