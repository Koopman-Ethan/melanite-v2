import '../envConfig'

import { eq, inArray } from 'drizzle-orm'

import { hashPassword } from '@/lib/auth/password'
import {
  EQUIPMENT_POLICY_VERSION,
  hasAcceptedEquipmentPolicy,
} from '@/lib/equipment-policy'
import { licenseStatus } from '@/lib/license'
import { providers } from '@/lib/db/schema'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// Restores the accounts the Playwright suite signs in as, in a NON-PRODUCTION database.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-e2e-credentials.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/dev-e2e-credentials.ts --check
//
// RUN IT AFTER EVERY REFRESH OF DEV, like `dev-connect-accounts.ts`.
//
// WHY THIS EXISTS
//
// `refresh-dev.ts` replaces dev wholesale with a scrubbed copy of production, `providers`
// included, and the scrub does not touch `password_hash`. So every morning the test accounts
// carry PRODUCTION's hashes and `E2E_PROVIDER_PASSWORD` stops opening them. The suite then
// fails at `auth.setup.ts` with the provider stuck on /login while the admin sails through,
// which reads as a regression in whatever you were working on rather than an environment
// problem. That cost a cycle on three separate days before this existed.
//
// It also repairs the BOOKING GATES, which is the half that is easy to miss. The e2e provider
// is a real provider's account, so it inherits their real-world state: on 2026-08-23 a genuine
// medical-director payment declined in production, and the next refresh imported `past_due`
// into dev and blocked the entire booking journey. Nothing was broken — dev was just faithfully
// reproducing somebody's billing problem.
//
// THE REAL FIX, not done here: the suite should sign in as a DEDICATED fixture provider rather
// than borrowing a real person's account. Then none of their real-world state matters and this
// script shrinks to a password. That is a bigger change — the specs assume an account with a
// service menu, a history and a Connect account — and it is worth doing before the roster grows.

const check = process.argv.includes('--check')

interface Repair {
  label: string
  fix: () => Promise<void>
}

async function main() {
  requireEnv(['dev'], 'restore the e2e test credentials')
  console.log(`\n${check ? 'Checking' : 'Restoring'} ${describeDatabase()}\n`)

  const providerEmail = (process.env.E2E_PROVIDER_EMAIL ?? '').trim().toLowerCase()
  const adminEmail = (process.env.E2E_ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.E2E_PROVIDER_PASSWORD ?? ''
  const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? password

  if (!providerEmail || !adminEmail || password.length < 12) {
    console.error('E2E_PROVIDER_EMAIL / E2E_ADMIN_EMAIL / E2E_PROVIDER_PASSWORD are not usable.')
    process.exitCode = 1
    return
  }

  const rows = await db
    .select({
      id: providers.id,
      email: providers.email,
      status: providers.status,
      licenseNumber: providers.licenseNumber,
      bookingEnabled: providers.bookingEnabled,
      medicalDirectorStatus: providers.medicalDirectorStatus,
      licenseExpiry: providers.licenseExpiry,
      equipmentPolicyAckVersion: providers.equipmentPolicyAckVersion,
      requiresPasswordReset: providers.requiresPasswordReset,
    })
    .from(providers)
    .where(inArray(providers.email, [providerEmail, adminEmail]))

  const provider = rows.find((r) => r.email.toLowerCase() === providerEmail)
  const admin = rows.find((r) => r.email.toLowerCase() === adminEmail)

  if (!provider || !admin) {
    console.error(
      `Missing test account(s): ${!provider ? providerEmail : ''} ${!admin ? adminEmail : ''}`.trim(),
    )
    process.exitCode = 1
    return
  }

  const repairs: Repair[] = []

  // Passwords are rewritten unconditionally rather than compared. A hash cannot be checked
  // without the plaintext, and the whole failure mode is a hash that LOOKS fine — present,
  // not flagged for reset — while belonging to a different password entirely.
  repairs.push({
    label: `password for ${provider.email}`,
    fix: async () => {
      await db
        .update(providers)
        .set({ passwordHash: await hashPassword(password), requiresPasswordReset: false })
        .where(eq(providers.id, provider.id))
    },
  })

  repairs.push({
    label: `password for ${admin.email}`,
    fix: async () => {
      await db
        .update(providers)
        .set({ passwordHash: await hashPassword(adminPassword), requiresPasswordReset: false })
        .where(eq(providers.id, admin.id))
    },
  })

  // The gates, but only where they are actually shut — so a run against a healthy dev makes no
  // writes and says so.
  if (provider.status !== 'active' || !provider.bookingEnabled) {
    repairs.push({
      label: `booking access for ${provider.email} (status ${provider.status}, enabled ${provider.bookingEnabled})`,
      fix: async () => {
        await db
          .update(providers)
          .set({ status: 'active', bookingEnabled: true })
          .where(eq(providers.id, provider.id))
      },
    })
  }

  if (provider.medicalDirectorStatus !== 'active') {
    repairs.push({
      label: `medical director for ${provider.email} (was '${provider.medicalDirectorStatus}' — imported from production)`,
      fix: async () => {
        await db
          .update(providers)
          .set({ medicalDirectorStatus: 'active' })
          .where(eq(providers.id, provider.id))
      },
    })
  }

  // The equipment policy stands in front of the booking form, so a suite that has not accepted
  // it cannot book — and the failure surfaces as "no time slots", which names nothing. Same
  // class of problem as the medical-director gate above: a real product behaviour that a test
  // fixture has to satisfy deliberately rather than by accident.
  if (!hasAcceptedEquipmentPolicy(provider.equipmentPolicyAckVersion)) {
    repairs.push({
      label: `equipment policy for ${provider.email} (${provider.equipmentPolicyAckVersion ?? 'never accepted'})`,
      fix: async () => {
        await db
          .update(providers)
          .set({
            equipmentPolicyAckAt: new Date(),
            equipmentPolicyAckVersion: EQUIPMENT_POLICY_VERSION,
          })
          .where(eq(providers.id, provider.id))
      },
    })
  }

  // Only when it would block. A real licence with a real future date is left exactly as it came
  // over, because the suite has no business rewriting a date it does not depend on.
  const license = licenseStatus(provider.licenseExpiry)
  if (license.state === 'missing' || license.state === 'expired') {
    repairs.push({
      label: `licence for ${provider.email} (${license.state})`,
      fix: async () => {
        const expiry = new Date()
        expiry.setFullYear(expiry.getFullYear() + 2)
        await db
          .update(providers)
          .set({
            // Keeps a real number if one came over — only the DATE is what blocks, and
            // replacing a genuine licence number with a fixture string loses information for
            // no benefit. `undefined` would have been silently omitted by Drizzle, which is
            // the right behaviour by accident and the wrong thing to rely on.
            licenseNumber: provider.licenseNumber ?? 'ZZ-E2E-LICENSE',
            licenseState: 'ID',
            licenseExpiry: expiry.toISOString().slice(0, 10),
          })
          .where(eq(providers.id, provider.id))
      },
    })
  }

  // In --check mode the passwords cannot be verified, so only the gates are reportable. Said
  // out loud rather than implied, because "0 problems" from a check that cannot see the most
  // common failure would be the worst possible output.
  if (check) {
    const gateProblems = repairs.filter((r) => !r.label.startsWith('password'))
    for (const r of gateProblems) console.log(`  BROKEN   ${r.label}`)
    console.log(
      gateProblems.length === 0
        ? '  ok       booking gates are open for the e2e provider'
        : `\n${gateProblems.length} gate(s) shut.`,
    )
    console.log(
      '\n  NOTE: passwords cannot be checked — a hash cannot be compared without the plaintext.' +
        '\n        Run without --check to rewrite them.\n',
    )
    if (gateProblems.length > 0) process.exitCode = 1
    return
  }

  for (const r of repairs) {
    await r.fix()
    console.log(`  fixed    ${r.label}`)
  }

  console.log(`\n${repairs.length} repair(s). The suite can sign in and book.\n`)
}

main().then(() => process.exit(process.exitCode ?? 0))
