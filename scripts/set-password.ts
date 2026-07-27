// Sets a provider's password directly. For bootstrapping the first admin and for local
// development — there is no self-service signup, providers are invited.
//
//   npm run db:set-password -- keoni@melanitesuite.com 'some-password'
//
// Also clears requiresPasswordReset, since the account now has a usable hash.

import { eq } from 'drizzle-orm'

import { hashPassword } from '@/lib/auth/password'
import { providers, sessions } from '@/lib/db/schema'

import { db } from './db'

async function main() {
  const [email, password] = process.argv.slice(2)

  if (!email || !password) {
    console.error("usage: npm run db:set-password -- <email> '<password>'")
    process.exitCode = 1
    return
  }

  if (password.length < 12) {
    console.error('refusing: use at least 12 characters')
    process.exitCode = 1
    return
  }

  const [provider] = await db
    .select({ id: providers.id, email: providers.email })
    .from(providers)
    .where(eq(providers.email, email.trim().toLowerCase()))
    .limit(1)

  if (!provider) {
    console.error(`no provider with email ${email}`)
    process.exitCode = 1
    return
  }

  await db
    .update(providers)
    .set({ passwordHash: await hashPassword(password), requiresPasswordReset: false })
    .where(eq(providers.id, provider.id))

  // Changing a password ends every existing session, so a device that knew the old one
  // cannot keep using it.
  await db.delete(sessions).where(eq(sessions.providerId, provider.id))

  console.log(`password set for ${provider.email}; existing sessions revoked`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
