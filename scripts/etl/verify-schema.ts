import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

import '../../envConfig'
import { describeDatabase, requireEnv } from '../../lib/env-guard'

// Does this database have the schema we think it has?
//
//   npm run db:verify                                     # whatever .env.local points at
//   MELANITE_ENV_FILE=.env.migration npm run db:verify    # production
//
// Run it after `drizzle-kit migrate` against a new database, and again after the data load.
//
// "The migrations ran" is not the same claim as "the guarantees are in place". Every check
// below is a rule the application relies on and cannot enforce by itself — and each one fails
// silently if it is missing. A booking overlaps and nobody notices until two clients arrive for
// the same laser; an invoice is recorded twice and revenue is simply wrong. Reading it back
// from the live database is the only way to know, because a migration that appears in the
// journal is only evidence that a file was executed.
//
// Emptiness is REPORTED, not required, so this is as useful the morning after the load as it is
// the day before.

interface Check {
  label: string
  /** Why it matters, in the terms of what breaks. Printed on failure. */
  because: string
  run: (q: Sql) => Promise<boolean>
}

type Sql = NeonQueryFunction<false, false>

const rows = async (q: Sql, sql: string) =>
  (await q.query(sql)) as Record<string, unknown>[]

const CHECKS: Check[] = [
  {
    label: '24 tables',
    because: 'a missing table means a migration did not run at all',
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
        )
      ).length === 24,
  },
  {
    label: 'btree_gist installed',
    because: 'the overlap constraint cannot exist without it',
    run: async (q) =>
      (await rows(q, `SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).length === 1,
  },
  {
    label: 'bookings_no_overlap exclusion constraint',
    because:
      'without it two bookings can hold the shared laser at once — the room had a database guard and the laser did not',
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap' AND contype = 'x'`,
        )
      ).length === 1,
  },
  {
    label: 'unique index on ledger stripe_invoice_id',
    because: 'without it one Stripe invoice can be banked twice and revenue reads high',
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT 1 FROM pg_indexes WHERE tablename = 'ledger_entries'
             AND indexdef ILIKE '%unique%' AND indexdef ILIKE '%stripe_invoice_id%'`,
        )
      ).length >= 1,
  },
  {
    label: 'external payment CHECK on bookings',
    because:
      'without it a booking can be "paid outside the app" without saying how, which Keoni cannot invoice against',
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT 1 FROM pg_constraint WHERE contype = 'c' AND conrelid = 'bookings'::regclass
             AND pg_get_constraintdef(oid) ILIKE '%external_method%'`,
        )
      ).length >= 1,
  },
  {
    label: 'cherry_started_at is not on checkout_links',
    because:
      'it was first added to checkout_links, which is 1:1 with a BOOKING — the two tables have ' +
      'near-identical column lists, so nothing complained and the value was written nowhere useful',
    // Asserts the absence, not an exact set of tables. It legitimately lives on
    // package_checkout_links and training_enrollments now, and will spread further as more
    // things can be financed; a check that has to be edited every time is one that gets its
    // number bumped without being read.
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT 1 FROM information_schema.columns
            WHERE column_name = 'cherry_started_at' AND table_name = 'checkout_links'`,
        )
      ).length === 0,
  },
  {
    label: 'every migration on disk has been applied',
    because: 'a short journal means the run stopped partway through',
    // Counted from the migration files rather than hardcoded. The number was literal, so the
    // first new migration after it was written turned a real check into a false alarm — and a
    // check that cries wolf gets its constant bumped without anybody reading what it verifies.
    run: async (q) => {
      const onDisk = readdirSync(join(process.cwd(), 'drizzle')).filter((f) =>
        f.endsWith('.sql'),
      ).length
      const [row] = (await rows(q, `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)) as {
        n: number
      }[]
      return row.n === onDisk
    },
  },
]

async function main() {
  // Allowed anywhere, because knowing the schema is right is never the dangerous operation —
  // but it still has to be stated, so nobody verifies one database believing it is another.
  const env = requireEnv(['dev', 'prod'], 'verify the schema')
  const q = neon(process.env.DATABASE_URL!)

  console.log(`\nVerifying ${describeDatabase()}  [${env}]\n`)

  let failed = 0
  for (const check of CHECKS) {
    let pass = false
    let error: string | null = null
    try {
      pass = await check.run(q)
    } catch (err) {
      error = String(err)
    }
    if (!pass) failed++
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${check.label}`)
    if (!pass) console.log(`       ${error ?? check.because}`)
  }

  // Reported, never asserted. Before the load this should be zero; after it, emphatically not.
  const tables = (await rows(
    q,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
  )) as { table_name: string }[]

  let total = 0
  for (const t of tables) {
    const [r] = (await rows(q, `SELECT count(*)::int AS n FROM "${t.table_name}"`)) as {
      n: number
    }[]
    total += r.n
  }
  console.log(`\n  ${total.toLocaleString('en-US')} rows across ${tables.length} tables`)

  if (failed > 0) {
    console.log(`\n${failed} check(s) failed. Do not load data into this database.\n`)
    process.exit(1)
  }
  console.log(`\nSchema verified.\n`)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
