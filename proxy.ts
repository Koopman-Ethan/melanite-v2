import { NextResponse, type NextRequest } from 'next/server'

import { SESSION_COOKIE } from '@/lib/auth/session'

// Next 16 renamed Middleware to Proxy. Same file-convention position, same behaviour.
//
// This is an OPTIMISTIC check and nothing more: it looks for the presence of a session
// cookie and redirects, without validating it. Per the Next authentication guide, Proxy runs
// on every request including prefetches, so it must not touch the database and must not be
// treated as the authorization boundary. A forged cookie gets past this file and is then
// rejected by `requireProvider()` in the Data Access Layer, which is where authorization
// actually happens.
//
// Its job is purely to save a round trip: send signed-out users to /login before rendering a
// page they cannot see, and keep signed-in users off the login form.

// `/onboarding` is a sibling of `/app`, not a child, so it needs listing separately — it is
// signed-in but deliberately outside the app shell. Missing it would not be a hole (the DAL
// still rejects the request) but it would cost a wasted render on every signed-out hit.
const PROTECTED_PREFIXES = ['/app', '/onboarding']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value)

  // The ONLY rule here, and it is deliberately one-directional: no cookie means definitely
  // not signed in, which is safe to act on without a database read.
  //
  // The mirror rule — bouncing a cookie-bearing request away from /login — was removed after
  // it produced an infinite redirect loop. An expired or forged cookie would be sent to
  // /app, where the DAL correctly rejected it and redirected back to /login, where this file
  // sent it to /app again. The cookie cannot be cleared from here to break the cycle either,
  // since a Server Component may not modify cookies during render.
  //
  // Redirecting an already-signed-in user away from /login now happens in the login page
  // itself, where the session has actually been verified.
  if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && !hasSessionCookie) {
    const url = new URL('/login', request.url)
    // Preserve where they were going so login can return them there.
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // Skip static assets and image optimisation; there is nothing to protect there and running
  // on them would only add latency.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)'],
}
