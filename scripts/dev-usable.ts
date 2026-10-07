import '../envConfig'

import { eq, sql } from 'drizzle-orm'

import { canBook, bookingBlockedReasons } from '@/lib/auth/dal'
import type { SessionUser } from '@/lib/auth/session'
import { providers, services } from '@/lib/db/schema'
import { RENTAL_TERMS_VERSION } from '@/lib/rental-terms'
import { liveScheduleVersion } from '@/lib/rental/schedule'

import { describeDatabase, requireEnv } from '../lib/env-guard'
import { db } from './db'

// Is this database actually usable as dev?
//
//   npm run dev:usable
//
// Runs LAST in the nightly refresh, after every repair.
//
// WHY THIS EXISTS AND WHY IT IS NOT A FOURTH REPAIR SCRIPT
//
// `refresh-dev.ts` replaces dev with a copy of production, so anything dev-specific is lost
// every night: test-mode Connect accounts, test passwords, the house provider, and — the one
// nobody predicted — a booking gate, when a real medical-director payment declined in
// production and the copy faithfully imported somebody's billing problem into the test
// environment.
//
// Each of those was discovered the same way: something broke, somebody spent a cycle assuming
// it was their own change, and a repair script was added. The repairs are necessary and they
// are not sufficient, because the list only ever contains the failures that have already
// happened. This asserts the END STATE instead — that the suite can sign in, that somebody can
// book, that the house provider is set up — so a fixture nobody has thought to repair fails the
// job here rather than in a spec whose error message is about something else.
//
// Same argument `db:verify` makes for schema: "the migrations ran" is not the claim you want.
//
// It only READS. Repair belongs in the scripts that own each fixture.

interface Check {
  label: string
  /** What breaks, in the terms of what somebody will actually see. Printed on failure. */
  because: string
  run: () => Promise<true | string>
}

/** The real gate function, given the real columns — rather than a re-derivation here that can
 *  drift from it. This is the whole point: dev is usable when `canBook` says so. */
function asSessionUser(row: {
  id: string
  email: string
  bookingEnabled: boolean
  medicalDirectorStatus: SessionUser['medicalDirectorStatus']
  licenseExpiry: string | null
  status: SessionUser['status']
  role: SessionUser['role']
}): SessionUser {
  return {
    ...row,
    firstName: '',
    lastName: '',
    roomRentalEnabled: true,
    requiresPasswordReset: false,
    hasMedicalDirectorOnFile: false,
  } as SessionUser
}

const PROVIDER_COLUMNS = {
  id: providers.id,
  email: providers.email,
  role: providers.role,
  status: providers.status,
  bookingEnabled: providers.bookingEnabled,
  medicalDirectorStatus: providers.medicalDirectorStatus,
  licenseExpiry: providers.licenseExpiry,
  revenueModel: providers.revenueModel,
  requiresPasswordReset: providers.requiresPasswordReset,
  hasPassword: sql<boolean>`${providers.passwordHash} is not null`,
}

async function byEmail(email: string) {
  const [row] = await db
    .select(PROVIDER_COLUMNS)
    .from(providers)
    .where(eq(providers.email, email.trim().toLowerCase()))
    .limit(1)
  return row ?? null
}

/** Services anybody can book. Since the rental model that is a property of the CATALOGUE, not
 *  of a provider — nobody picks a menu, and the `provider_services` row appears when they first
 *  book something. */
async function bookableServiceCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(services)
    .where(sql`${services.active}`)
  return row?.n ?? 0
}

const CHECKS: Check[] = [
  {
    label: 'the e2e accounts exist and can be signed in to',
    because: 'auth.setup.ts fails and every signed-in spec is skipped',
    run: async () => {
      const problems: string[] = []
      for (const [name, email] of [
        ['E2E_PROVIDER_EMAIL', process.env.E2E_PROVIDER_EMAIL],
        ['E2E_ADMIN_EMAIL', process.env.E2E_ADMIN_EMAIL],
      ] as const) {
        if (!email) {
          problems.push(`${name} is not set`)
          continue
        }
        const row = await byEmail(email)
        if (!row) problems.push(`${email} has no provider row`)
        else if (!row.hasPassword) problems.push(`${email} has no password hash`)
        else if (row.requiresPasswordReset) problems.push(`${email} is forced through a reset`)
        else if (row.status !== 'active') problems.push(`${email} is '${row.status}'`)
      }
      return problems.length === 0 ? true : problems.join('; ')
    },
  },
  {
    label: 'the e2e provider passes every booking gate',
    because:
      'the booking journey renders the gates page instead of the form, and fails on a missing time slot — an error about availability, for a problem that is nothing to do with availability',
    run: async () => {
      const email = process.env.E2E_PROVIDER_EMAIL
      if (!email) return 'E2E_PROVIDER_EMAIL is not set'
      const row = await byEmail(email)
      if (!row) return `${email} has no provider row`

      const user = asSessionUser(row)
      if (canBook(user)) return true

      return bookingBlockedReasons(user)
        .map((g) => g.gate)
        .join(', ')
    },
  },
  {
    label: 'there is something to book',
    because: 'the book page renders an empty dropdown and no slots',
    run: async () => {
      // Asked of the CATALOGUE, not of one provider. It used to count that provider's
      // `provider_services` rows, which was right while a menu had to be picked during setup;
      // since the rental model nobody has rows until they book, so a correct environment
      // failed this every morning.
      const n = await bookableServiceCount()
      return n > 0 ? true : 'no active services in the catalogue'
    },
  },
  {
    label: 'the owner is set up as a house provider',
    because: 'appdev cannot demonstrate Melanite treating its own clients',
    run: async () => {
      const [owner] = await db
        .select(PROVIDER_COLUMNS)
        .from(providers)
        .where(eq(providers.role, 'platform_owner'))
        .limit(1)

      if (!owner) return 'no platform_owner row'

      const problems = [
        owner.revenueModel !== 'house' && `revenue_model is '${owner.revenueModel}'`,
        !canBook(asSessionUser(owner)) &&
          `blocked by ${bookingBlockedReasons(asSessionUser(owner)).map((g) => g.gate).join(', ')}`,
        // NOT "has active services" any more. Nobody configures a service menu since the
        // rental model — every active service is bookable by everybody, and the
        // `provider_services` row is created by `createBooking` the first time somebody books
        // one. Requiring rows here failed every morning after the refresh and described a
        // setup step that no longer exists.
        (await bookableServiceCount()) === 0 && 'the catalogue has no bookable services',
      ].filter((p): p is string => typeof p === 'string')

      return problems.length === 0 ? true : problems.join('; ')
    },
  },
  {
    label: 'no provider is left holding a production Stripe account',
    because:
      'every payment path in dev fails with "Could not start the payment" — a live acct_ id is invisible to a test key, and returns 403 rather than 404',
    run: async () => {
      // Deliberately shallow: `dev-connect-accounts.ts --check` asks Stripe whether each account
      // is really visible, which is the authoritative answer and needs an API call per provider.
      // This only catches the blunt case of the copy having brought ids over with none replaced.
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(providers)
        .where(sql`${providers.stripeAccountId} is not null and ${providers.status} = 'active'`)

      return (row?.n ?? 0) > 0
        ? true
        : 'no active provider has a Stripe account at all — dev-connect-accounts.ts has not run'
    },
  },
  {
    label: 'a bookable provider can actually pay the rental fee',
    because:
      'under the rental model booking refuses without a card on file and without the current terms accepted — a provider who passes every gate above still cannot book',
    run: async () => {
      const schedule = await liveScheduleVersion()
      if (schedule === null) return 'no fee schedule published — etl:rental-fees has not run'

      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(providers)
        .where(
          sql`${providers.status} = 'active'
              AND ${providers.bookingEnabled}
              AND ${providers.revenueModel} <> 'house'
              AND ${providers.billingCardLast4} IS NOT NULL
              AND ${providers.rentalTermsVersion} = ${RENTAL_TERMS_VERSION}
              AND ${providers.rentalScheduleVersion} = ${schedule}`,
        )

      return (row?.n ?? 0) > 0
        ? true
        : 'no bookable provider has a card and current terms — dev-rental-ready.ts has not run'
    },
  },
  {
    label: 'no provider is left holding a production Stripe customer',
    because:
      'the nightly copy brings live cus_ ids across, and a card setup against one fails with "No such customer" — which reads like a permissions problem and is not',
    run: async () => {
      // The billing customer is the mirror of the Connect account above, and was missed when
      // that check was written because nothing charged a provider yet. `dev-rental-ready.ts`
      // replaces a live id when it finds one; this notices if it has not been run since the
      // last refresh.
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(providers)
        .where(
          sql`${providers.stripeBillingCustomerId} IS NOT NULL
              AND ${providers.billingPaymentMethodId} IS NULL
              AND ${providers.status} = 'active'
              AND ${providers.revenueModel} <> 'house'`,
        )

      const n = row?.n ?? 0
      return n === 0
        ? true
        : `${n} active provider(s) have a billing customer but no payment method — likely live ids from the copy`
    },
  },
]

async function main() {
  // Allowed against dev only. Production being "usable as dev" is not a question worth asking,
  // and several of these would be alarming if they were TRUE there.
  requireEnv(['dev'], 'check that dev is usable')

  console.log(`\nIs ${describeDatabase()} usable as dev?\n`)

  let failed = 0
  for (const check of CHECKS) {
    let result: true | string
    try {
      result = await check.run()
    } catch (err) {
      result = String(err).split('\n')[0]
    }

    const ok = result === true
    if (!ok) failed++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${check.label}`)
    if (!ok) {
      console.log(`       ${result}`)
      console.log(`       -> ${check.because}`)
    }
  }

  if (failed > 0) {
    console.log(
      `\n${failed} check(s) failed. Dev will produce test failures that look like product bugs.` +
        `\nRepair with: dev-connect-accounts.ts, dev-e2e-credentials.ts, dev-house-provider.ts, dev-rental-ready.ts\n`,
    )
    process.exit(1)
  }

  console.log('\nDev is usable.\n')
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
