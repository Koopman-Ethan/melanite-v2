import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, lt, ne } from 'drizzle-orm'
import { cookies } from 'next/headers'

import { db } from '@/lib/db'
import { providers, sessions } from '@/lib/db/schema'

export const SESSION_COOKIE = 'melanite_session'

/** Seven days. Long enough that providers aren't re-authenticating between clients, short
 *  enough to bound an abandoned session on a shared device. Revocation does not depend on
 *  this — deleting the row ends the session immediately. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The cookie holds the raw token; the table holds only this hash. SHA-256 is right here and
 *  scrypt would be wrong: the token is 256 bits of entropy we generated, not a low-entropy
 *  human secret, so there is nothing to brute-force and no reason to pay a KDF cost per
 *  request. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createSession(
  providerId: string,
  meta: { userAgent?: string | null; ipAddress?: string | null } = {},
) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await db.insert(sessions).values({
    providerId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
    ipAddress: meta.ipAddress ?? null,
  })

  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  // Opportunistic cleanup — no cron needed at this volume.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))

  return { token, expiresAt }
}

export interface SessionUser {
  id: string
  email: string
  firstName: string
  lastName: string
  role: (typeof providers.$inferSelect)['role']
  status: (typeof providers.$inferSelect)['status']
  bookingEnabled: boolean
  medicalDirectorStatus: (typeof providers.$inferSelect)['medicalDirectorStatus']
  /** `YYYY-MM-DD`, or null when the provider has none on file. A lapsed licence blocks
   *  booking — v1's LICENSE_EXPIRED gate, which is easy to miss because it lives in the
   *  create endpoint rather than alongside the other two gates. */
  licenseExpiry: string | null
  requiresPasswordReset: boolean
}

/** Resolves the cookie to a live provider, or null. Reads the provider row every time on
 *  purpose: role, status and the booking gates must be current, which is the entire reason
 *  for database sessions over a stateless token. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null

  const [row] = await db
    .select({
      id: providers.id,
      email: providers.email,
      firstName: providers.firstName,
      lastName: providers.lastName,
      role: providers.role,
      status: providers.status,
      bookingEnabled: providers.bookingEnabled,
      medicalDirectorStatus: providers.medicalDirectorStatus,
      licenseExpiry: providers.licenseExpiry,
      requiresPasswordReset: providers.requiresPasswordReset,
    })
    .from(sessions)
    .innerJoin(providers, eq(sessions.providerId, providers.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)

  if (!row) return null

  // A deactivated account is signed out on its next request, and its sessions are dropped so
  // other devices go too.
  if (row.status === 'inactive') {
    await db.delete(sessions).where(eq(sessions.providerId, row.id))
    return null
  }

  return row
}

export async function destroySession() {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
  store.delete(SESSION_COOKIE)
}

/** Ends every session for a provider — use when deactivating an account, or from an admin
 *  path where there is no "current" session to keep. */
export async function destroyAllSessions(providerId: string) {
  await db.delete(sessions).where(eq(sessions.providerId, providerId))
}

/** Ends every session EXCEPT the one making the request.
 *
 *  This is what a password change wants: other devices lose access immediately, but the
 *  provider is not signed out of the page they are standing on, which would look like the
 *  change failed. */
export async function destroyOtherSessions(providerId: string) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value

  if (!token) {
    await db.delete(sessions).where(eq(sessions.providerId, providerId))
    return
  }

  await db
    .delete(sessions)
    .where(
      and(eq(sessions.providerId, providerId), ne(sessions.tokenHash, hashToken(token))),
    )
}
