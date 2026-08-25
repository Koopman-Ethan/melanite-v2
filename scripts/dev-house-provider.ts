import '../envConfig'

import { eq } from 'drizzle-orm'

import { hashPassword } from '@/lib/auth/password'
import { providerServices, providers, services } from '@/lib/db/schema'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// Sets the platform owner up as a `house` provider in a NON-PRODUCTION database.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-house-provider.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-house-provider.ts --check
//
// RUN IT AFTER EVERY REFRESH OF DEV, like `dev-connect-accounts.ts`.
//
// WHY THIS EXISTS
//
// `refresh-dev.ts` replaces dev wholesale with a scrubbed copy of production, `providers`
// included. Production has no house provider — that is the thing being reviewed — so every
// morning the copy silently puts Keoni back on the revenue split with no licence, no services
// and booking disabled, and appdev stops being able to demonstrate the feature at all.
//
// It is the same shape as the two repairs the nightly workflow already runs, and the same
// lesson as the service catalogue: anything the copy rebuilds cannot hold a v2-only decision
// unless something re-applies it afterwards.
//
// Deliberately NOT a migration and NOT seed data. It is environment repair, it is idempotent,
// and it refuses to run against production — where these values are a real business decision
// somebody makes on purpose, not something a script asserts.

/** Her Idaho esthetician licence. The public register lists an RN licence too (65517, expiring
 *  2027-08-31); the schema holds one licence per provider, and this is the one that covers the
 *  treatments in this catalogue AND expires first, so it is the one the gate should watch. */
const LICENSE = { number: 'EST-254813', state: 'ID', expiry: '2027-08-27' }

/** One service so `/app/book` has something to offer. Any active service will do — the point is
 *  that she has a priced menu at all, not which treatment it is. */
const SERVICE_PRICE = '180.00'

const check = process.argv.includes('--check')

async function main() {
  requireEnv(['dev'], 'set up a house provider')
  console.log(`\n${check ? 'Checking' : 'Setting up'} ${describeDatabase()}\n`)

  const [owner] = await db
    .select({
      id: providers.id,
      email: providers.email,
      firstName: providers.firstName,
      revenueModel: providers.revenueModel,
      bookingEnabled: providers.bookingEnabled,
      licenseExpiry: providers.licenseExpiry,
      medicalDirectorStatus: providers.medicalDirectorStatus,
    })
    .from(providers)
    .where(eq(providers.role, 'platform_owner'))
    .limit(1)

  if (!owner) {
    console.error('No platform_owner row in this database — nothing to set up.')
    process.exitCode = 1
    return
  }

  const [existingService] = await db
    .select({ id: providerServices.id })
    .from(providerServices)
    .where(eq(providerServices.providerId, owner.id))
    .limit(1)

  const problems = [
    owner.revenueModel !== 'house' && `revenue_model is '${owner.revenueModel}', not 'house'`,
    !owner.bookingEnabled && 'booking_enabled is false',
    owner.licenseExpiry !== LICENSE.expiry && `license expiry is ${owner.licenseExpiry ?? 'not set'}`,
    !existingService && 'no priced services',
  ].filter((p): p is string => typeof p === 'string')

  if (problems.length === 0) {
    console.log(`${owner.firstName} is already set up as a house provider.\n`)
    return
  }

  if (check) {
    for (const p of problems) console.log(`  MISSING  ${p}`)
    console.log(`\n${problems.length} thing(s) to fix. Re-run without --check.\n`)
    process.exitCode = 1
    return
  }

  await db
    .update(providers)
    .set({
      revenueModel: 'house',
      bookingEnabled: true,
      licenseNumber: LICENSE.number,
      licenseState: LICENSE.state,
      licenseExpiry: LICENSE.expiry,
    })
    .where(eq(providers.id, owner.id))

  for (const p of problems) console.log(`  fixed    ${p}`)

  if (!existingService) {
    const [service] = await db
      .select({ id: services.id, name: services.name, duration: services.suggestedDurationMins })
      .from(services)
      .where(eq(services.active, true))
      .limit(1)

    if (service) {
      await db.insert(providerServices).values({
        providerId: owner.id,
        serviceId: service.id,
        price: SERVICE_PRICE,
        durationMins: service.duration,
        isActive: true,
      })
      console.log(`  added    ${service.name} at $${SERVICE_PRICE}`)
    }
  }

  // A password only if there is one to copy. Reuses the credential the Playwright suite already
  // holds rather than inventing a second secret, and never prints it.
  const password = process.env.E2E_PROVIDER_PASSWORD
  if (password && password.length >= 12) {
    await db
      .update(providers)
      .set({ passwordHash: await hashPassword(password), requiresPasswordReset: false })
      .where(eq(providers.id, owner.id))
    console.log(`  set      password for ${owner.email} (same as E2E_PROVIDER_PASSWORD)`)
  }

  // Worth saying out loud rather than letting it be discovered at the gates page: the medical
  // director gate applies to her exactly as it does to everybody else.
  if (owner.medicalDirectorStatus !== 'active') {
    console.log(
      `\n  NOTE: medical_director_status is '${owner.medicalDirectorStatus}', which still` +
        `\n        blocks booking. The gates page will say so.`,
    )
  }

  console.log('\nDone. She can book at /app/book and set her own prices at /app/services.\n')
}

main().then(() => process.exit(process.exitCode ?? 0))
