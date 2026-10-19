import '../envConfig'

import { eq } from 'drizzle-orm'

import { providers } from '@/lib/db/schema'

import { describeDatabase, requireEnv, requireProductionOptIn } from '../lib/env-guard'
import { db } from './db'

// Retires a provider who has left, WITHOUT deleting them.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/retire-provider.ts --email someone@example.com
//   npx tsx --tsconfig scripts/tsconfig.json scripts/retire-provider.ts --email someone@example.com --apply
//
// WHY DELETING IS NOT AN OPTION
//
// A departed provider is the subject of real history: appointments that happened, ledger rows
// recording money that moved, end-of-use checklists signing off a shared medical device. Every
// one of those references `providers.id`. Deleting the row either cascades that history away or
// is refused by a foreign key — and the first outcome is much worse than the second, because it
// looks like it worked.
//
// So "they have left" is a STATUS, not an absence. `status = 'inactive'` with booking and room
// access off is what the app already understands: they cannot sign in and book, nobody charges
// them rent, the cutover scripts skip them, and everything they did is still there to read.
//
// THE E2E ACCOUNT. Nichole Mim left Melanite in October and is also `E2E_PROVIDER_EMAIL` — the
// account the whole Playwright suite signs in as. Keeping her is deliberate: she has a service
// menu, a booking history and a Connect account, which is exactly what those specs assume, and
// a retired provider makes a BETTER fixture than a working one. The long-standing worry in
// `dev-e2e-credentials.ts` was that borrowing a real person's account meant inheriting their
// real-world state — a genuine medical-director decline once blocked the whole suite. Once she
// is retired, there is no real-world state left to inherit.
//
// Retiring her does flow to dev on the next refresh, and `dev-e2e-credentials.ts` already
// repairs it: it reopens the booking gates for the e2e provider whenever they are shut, which
// has been in there since August and is now load-bearing on every single run rather than
// occasionally. That script runs as part of `npm run dev:after-refresh`.

const apply = process.argv.includes('--apply')

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

async function main() {
  const email = (arg('email') ?? '').trim().toLowerCase()
  if (!email) {
    console.error('Pass --email <address>.')
    process.exitCode = 1
    return
  }

  const env = requireEnv(['dev', 'prod'], `retire ${email}`)
  if (env === 'prod') requireProductionOptIn(`retire ${email}`)

  console.log(`\n${apply ? 'Retiring' : 'Dry run against'} ${describeDatabase()}\n`)

  const [row] = await db
    .select({
      id: providers.id,
      email: providers.email,
      firstName: providers.firstName,
      lastName: providers.lastName,
      status: providers.status,
      role: providers.role,
      bookingEnabled: providers.bookingEnabled,
      roomRentalEnabled: providers.roomRentalEnabled,
      revenueModel: providers.revenueModel,
      rentBasis: providers.rentBasis,
    })
    .from(providers)
    .where(eq(providers.email, email))
    .limit(1)

  if (!row) {
    console.error(`  No provider with the email ${email}.\n`)
    process.exitCode = 1
    return
  }

  const name = `${row.firstName} ${row.lastName}`
  console.log(`  ${name} <${row.email}>`)
  console.log(`    status           ${row.status}`)
  console.log(`    booking          ${row.bookingEnabled ? 'enabled' : 'disabled'}`)
  console.log(`    room rental      ${row.roomRentalEnabled ? 'enabled' : 'disabled'}`)
  console.log(`    billing          ${row.revenueModel} / ${row.rentBasis}`)

  if (row.status === 'inactive' && !row.bookingEnabled && !row.roomRentalEnabled) {
    console.log('\n  Already retired. Nothing to do.\n')
    return
  }

  // Said out loud, because it is the thing somebody running this would not have thought about
  // and would discover tomorrow morning as a red test suite.
  if (email === (process.env.E2E_PROVIDER_EMAIL ?? '').trim().toLowerCase()) {
    console.log('')
    console.log('  NOTE: this is E2E_PROVIDER_EMAIL — the account the Playwright suite books as.')
    console.log('        Retiring shuts the booking gates, and the next refresh carries that to')
    console.log('        dev. `npm run dev:after-refresh` reopens them (dev-e2e-credentials.ts),')
    console.log('        so run it after the next refresh or the suite will fail at auth.setup.')
  }

  console.log('\n  WHAT STAYS: every appointment, ledger row, checklist and photograph. This is')
  console.log('  a status change, not a deletion — their history is still answerable.')

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to retire them.\n')
    return
  }

  await db
    .update(providers)
    .set({ status: 'inactive', bookingEnabled: false, roomRentalEnabled: false })
    .where(eq(providers.id, row.id))

  console.log(`\n  ${name} is retired: inactive, no booking, no room rental.\n`)
}

main().then(() => process.exit(process.exitCode ?? 0))
