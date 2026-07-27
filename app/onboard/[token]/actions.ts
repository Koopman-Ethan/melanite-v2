'use server'

import { and, eq } from 'drizzle-orm'

import { hashPassword } from '@/lib/auth/password'
import { passwordProblems } from '@/lib/auth/password-policy'
import { createSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { providerExists } from '@/lib/db/queries/invites'
import { inviteLinks, providers } from '@/lib/db/schema'

export interface ActivateState {
  error?: string
  ok?: boolean
}

/**
 * Accepts an invite: creates the provider account and signs them in.
 *
 * The account is created `pending`, NOT active, with `bookingEnabled` false. Finishing
 * onboarding is not consent to practise — Keoni still confirms insurance and medical-director
 * documents by email before anyone takes a client. Creating an active provider here would hand
 * out booking access on the strength of an email address.
 */
export async function activateAccount(input: {
  token: string
  password: string
  confirm: string
}): Promise<ActivateState> {
  const problems = passwordProblems(input.password)
  if (problems.length > 0) return { error: `Your password needs ${problems.join(', ')}.` }
  if (input.password !== input.confirm) return { error: 'The two passwords don’t match.' }

  const [invite] = await db
    .select({
      id: inviteLinks.id,
      email: inviteLinks.email,
      status: inviteLinks.status,
      expiresAt: inviteLinks.expiresAt,
    })
    .from(inviteLinks)
    .where(eq(inviteLinks.token, input.token))
    .limit(1)

  if (!invite) return { error: 'That invite link is not valid.' }
  if (invite.status === 'accepted') {
    return { error: 'This invite has already been used. Sign in instead.' }
  }
  if (invite.status !== 'pending' || invite.expiresAt < new Date()) {
    return { error: 'This invite has expired. Ask Keoni for a new one.' }
  }

  // Re-checked here, not only when the invite was issued: an account could have appeared by any
  // route in the days since.
  if (await providerExists(invite.email)) {
    return { error: 'An account already exists for that email. Sign in instead.' }
  }

  // The invite is CLAIMED FIRST, conditionally on it still being pending. Two browsers
  // submitting at once then produce one winner and one "already used" — creating the provider
  // first and claiming afterwards would let both create an account and leave one orphaned.
  const claimed = await db
    .update(inviteLinks)
    .set({ status: 'accepted', acceptedAt: new Date() })
    .where(and(eq(inviteLinks.id, invite.id), eq(inviteLinks.status, 'pending')))
    .returning({ id: inviteLinks.id })

  if (claimed.length === 0) {
    return { error: 'This invite has already been used. Sign in instead.' }
  }

  const [provider] = await db
    .insert(providers)
    .values({
      email: invite.email,
      passwordHash: await hashPassword(input.password),
      requiresPasswordReset: false,
      // Collected on the next step. Empty rather than guessed from an email address.
      firstName: '',
      lastName: '',
      role: 'provider',
      status: 'pending',
      onboardingStep: 1,
      bookingEnabled: false,
    })
    .returning({ id: providers.id })

  await createSession(provider.id)

  return { ok: true }
}
