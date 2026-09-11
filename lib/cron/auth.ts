import { timingSafeEqual } from 'node:crypto'

// Who is allowed to trigger a scheduled job.
//
// Separated from the route for the same reason `lib/stripe/signature.ts` is separated from the
// webhook route: the credential check is the part worth testing, and a route handler is an
// awkward thing to test.

export type CronAuth = { ok: true } | { ok: false; reason: 'not-configured' | 'missing' | 'mismatch' }

/**
 * Checks an `Authorization: Bearer <token>` header against the configured secret.
 *
 * An UNSET secret is `not-configured`, and the caller must refuse rather than run. Same rule as
 * the Stripe webhook: without a secret there is no way to tell the scheduler from anybody who
 * found the URL, and failing open on a job that sends mail is not a failure worth having.
 */
export function checkCronBearer(header: string | null, secret: string | undefined): CronAuth {
  const expected = secret?.trim()
  if (!expected) return { ok: false, reason: 'not-configured' }

  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return { ok: false, reason: 'missing' }

  const token = header.slice(prefix.length).trim()
  if (!token) return { ok: false, reason: 'missing' }

  const given = Buffer.from(token)
  const want = Buffer.from(expected)

  // Length is compared first because `timingSafeEqual` THROWS on a length mismatch rather than
  // returning false — the same trap `lib/stripe/signature.ts` already documents.
  if (given.length !== want.length) return { ok: false, reason: 'mismatch' }

  return timingSafeEqual(given, want) ? { ok: true } : { ok: false, reason: 'mismatch' }
}
