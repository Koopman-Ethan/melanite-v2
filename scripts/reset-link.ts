// Issues a password reset link and prints it, without sending email.
//
//   npm run db:reset-link -- someone@example.com
//   npm run db:reset-link -- --all
//
// Why this exists: the eight providers imported from Xano have no usable password hash — its
// hashing is not portable — so none of them can sign in until they reset. Until RESEND_API_KEY
// is configured the app cannot email them, so links have to come from somewhere.
//
// The printed link is a one-hour, single-use credential for that account. Send it over
// something private, and prefer configuring email over doing this at scale.

import '../envConfig'

import { asc, eq } from 'drizzle-orm'

import { createResetToken } from '@/lib/auth/reset'
import { providers } from '@/lib/db/schema'

import { db } from './db'

const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000'

async function issue(email: string) {
  const result = await createResetToken(email)
  if (!result) {
    console.log(`  ${email.padEnd(34)} SKIPPED (no active account)`)
    return
  }
  console.log(`  ${email.padEnd(34)} ${BASE}/reset-password?token=${result.token}`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--all')) {
    const rows = await db
      .select({ email: providers.email })
      .from(providers)
      .where(eq(providers.requiresPasswordReset, true))
      .orderBy(asc(providers.email))

    if (rows.length === 0) {
      console.log('No accounts are awaiting a password reset.')
      return
    }

    console.log(`Issuing reset links for ${rows.length} account(s) — each valid one hour:\n`)
    for (const r of rows) await issue(r.email)
    console.log('\nThese are single-use credentials. Send them privately.')
    return
  }

  const email = args[0]
  if (!email) {
    console.error('usage: npm run db:reset-link -- <email>   |   npm run db:reset-link -- --all')
    process.exitCode = 1
    return
  }

  console.log('')
  await issue(email)
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
