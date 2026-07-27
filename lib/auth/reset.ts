import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'

import { db } from '@/lib/db'
import { passwordResetTokens, providers, sessions } from '@/lib/db/schema'

import { hashPassword } from './password'

/** One hour, matching v1. Long enough to find the email, short enough that a link left in an
 *  inbox stops being a key. */
const TOKEN_TTL_MS = 60 * 60 * 1000

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Issues a reset token and returns the raw value — the ONLY time it exists in plaintext.
 *  Returns null when the email matches no account, so callers can respond identically either
 *  way rather than confirming which addresses are registered. */
export async function createResetToken(
  email: string,
): Promise<{ token: string; providerId: string; firstName: string } | null> {
  const [provider] = await db
    .select({ id: providers.id, status: providers.status, firstName: providers.firstName })
    .from(providers)
    .where(eq(providers.email, email.trim().toLowerCase()))
    .limit(1)

  if (!provider || provider.status === 'inactive') return null

  // Supersede any outstanding tokens. Two live links to the same account widens the window
  // for no benefit.
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.providerId, provider.id), isNull(passwordResetTokens.usedAt)))

  const token = randomBytes(32).toString('base64url')
  await db.insert(passwordResetTokens).values({
    providerId: provider.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  })

  // Opportunistic cleanup of long-dead rows.
  await db
    .delete(passwordResetTokens)
    .where(
      or(
        lt(passwordResetTokens.expiresAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        lt(passwordResetTokens.usedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
      ),
    )

  return { token, providerId: provider.id, firstName: provider.firstName }
}

export interface ResetTokenOwner {
  providerId: string
  email: string
  firstName: string
}

/** Resolves a raw token to its account, or null when missing, expired or already used. */
export async function findResetTokenOwner(token: string): Promise<ResetTokenOwner | null> {
  if (!token) return null

  const [row] = await db
    .select({
      providerId: providers.id,
      email: providers.email,
      firstName: providers.firstName,
    })
    .from(passwordResetTokens)
    .innerJoin(providers, eq(passwordResetTokens.providerId, providers.id))
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashToken(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)

  return row ?? null
}

/** Consumes the token and sets the password. Also ends every existing session for the
 *  account: if the reset was triggered because someone else had access, leaving their
 *  session alive would defeat the point. */
export async function consumeResetToken(token: string, newPassword: string): Promise<boolean> {
  const owner = await findResetTokenOwner(token)
  if (!owner) return false

  await db
    .update(providers)
    .set({ passwordHash: await hashPassword(newPassword), requiresPasswordReset: false })
    .where(eq(providers.id, owner.providerId))

  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.tokenHash, hashToken(token)))

  await db.delete(sessions).where(eq(sessions.providerId, owner.providerId))

  return true
}

/** Basic strength floor. Deliberately length-first rather than a character-class rule, which
 *  pushes people toward `Password1!` and is worse. */
export function validatePassword(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.'
  if (password.length > 200) return 'That password is too long.'
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Include at least one letter and one number.'
  }
  return null
}
