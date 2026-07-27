'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password'
import { createSession, destroySession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'

export interface LoginState {
  error?: string
}

/** Deliberately identical for "no such account", "wrong password" and "no usable hash".
 *  Distinguishing them turns the login form into an account-existence oracle. */
const INVALID = 'Email or password is incorrect.'

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '/app')

  if (!email || !password) return { error: 'Enter your email and password.' }

  const [provider] = await db
    .select({
      id: providers.id,
      passwordHash: providers.passwordHash,
      status: providers.status,
      requiresPasswordReset: providers.requiresPasswordReset,
    })
    .from(providers)
    .where(eq(providers.email, email))
    .limit(1)

  // Hash even when the account does not exist, so a missing account is not detectably
  // faster than a wrong password.
  const ok = await verifyPassword(password, provider?.passwordHash ?? null)
  if (!provider || !ok) return { error: INVALID }

  if (provider.status === 'inactive') {
    return { error: 'This account has been deactivated. Contact Melanite.' }
  }

  // Transparently upgrade a hash made with weaker parameters, now that we hold the plaintext.
  if (needsRehash(provider.passwordHash)) {
    await db
      .update(providers)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(providers.id, provider.id))
  }

  const headerList = await headers()
  await createSession(provider.id, {
    userAgent: headerList.get('user-agent'),
    ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })

  await db.update(providers).set({ lastLoginAt: new Date() }).where(eq(providers.id, provider.id))

  // Only relative paths, or this becomes an open redirect.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/app')
}

export async function logout() {
  await destroySession()
  redirect('/login')
}
