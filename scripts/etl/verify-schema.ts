import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

import '../../envConfig'
import { describeDatabase, requireEnv } from '../../lib/env-guard'
import * as schema from '@/lib/db/schema'
import { db } from '../db'

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
  /** `true` passes. A STRING fails and is printed instead of `because` — for checks that can
   *  say which object is missing, which is the difference between "go and look" and "go and
   *  fix this one thing at 11pm". */
  run: (q: Sql) => Promise<boolean | string>
}

type Sql = NeonQueryFunction<false, false>

const rows = async (q: Sql, sql: string) =>
  (await q.query(sql)) as Record<string, unknown>[]

/** Every table the application code declares, read out of the schema module rather than listed
 *  here. A hand-maintained list is a second source of truth that goes stale silently. */
const appTables = (): PgTable[] => Object.values(schema).filter((v) => is(v, PgTable))

/** Every enum, likewise. `enumName` is written explicitly in the schema, so unlike column names
 *  it needs no casing conversion. */
const appEnums = (): { enumName: string; enumValues: readonly string[] }[] =>
  // Through `unknown` so the predicate is legal: the union of everything the schema module
  // exports is far wider than the shape being narrowed to.
  (Object.values(schema) as unknown[]).filter(
    (v): v is { enumName: string; enumValues: readonly string[] } =>
      !!v &&
      typeof v === 'object' &&
      'enumName' in v &&
      Array.isArray((v as { enumValues?: unknown }).enumValues),
  )

const firstLine = (err: unknown) => String(err).split('\n')[0].replace(/^Error:\s*/, '')

const CHECKS: Check[] = [
  // Replaces a hardcoded "27 tables" count, which was weaker in both directions: it needed
  // editing on every migration, and a database that had gained one table while losing another
  // still counted 27 and passed.
  {
    label: 'every table and column the code reads',
    because: 'the app queries columns by name; one that is not there takes the page down',
    run: async (q) => {
      // Drizzle generates the SQL, so this asks the question the APPLICATION asks — same
      // casing cache, same column list — rather than a copy of it that can drift. EXPLAIN
      // plans the statement without executing it, which is enough to resolve every table and
      // column named in it, and reads nothing.
      //
      // This is the check that would have caught 2026-08-19: `prepaid_redemptions` was
      // missing, `/app/appointments` was down for every provider, and the schema still
      // counted the number of tables it expected to see minus three.
      const broken: string[] = []

      for (const table of appTables()) {
        const { sql } = db.select().from(table).toSQL()
        try {
          await q.query(`EXPLAIN ${sql}`)
        } catch (err) {
          broken.push(`${getTableName(table)} — ${firstLine(err)}`)
        }
      }

      return broken.length === 0 ? true : broken.join('\n       ')
    },
  },
  {
    label: 'every enum value the code uses',
    because:
      'ALTER TYPE ... ADD VALUE is its own statement and is the easiest half of a migration to leave behind',
    run: async (q) => {
      // Not covered by the check above: a SELECT plans perfectly well against an enum that is
      // missing a value. It is the INSERT that fails, later, in production, on the one payment
      // source nobody tested.
      const live = new Map<string, Set<string>>()
      for (const r of await rows(
        q,
        `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`,
      )) {
        const name = r.typname as string
        if (!live.has(name)) live.set(name, new Set())
        live.get(name)!.add(r.enumlabel as string)
      }

      const gaps: string[] = []
      for (const e of appEnums()) {
        const have = live.get(e.enumName)
        if (!have) {
          gaps.push(`${e.enumName} — the type does not exist`)
          continue
        }
        const missing = e.enumValues.filter((v) => !have.has(v))
        if (missing.length > 0) gaps.push(`${e.enumName} — missing ${missing.join(', ')}`)
      }

      return gaps.length === 0 ? true : gaps.join('\n       ')
    },
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
    label: 'cherry_started_at is on all three financeable things',
    because:
      'a hand-off written to a column that is missing on this environment throws, and the catch ' +
      'around it swallows the error — the client reaches Cherry and nobody ever hears about it',
    // This check used to assert the column's ABSENCE from checkout_links, because that is where
    // it was first added by mistake while building PACKAGE financing: the two tables have
    // near-identical column lists, so the write compiled, matched nothing, and recorded nowhere.
    //
    // Appointments can be financed now, so the column belongs there and that check would be a
    // permanent false alarm. The original mistake — writing to the wrong table — is not
    // something a schema check can see, so it is covered by test/cherry-handoff.test.ts, which
    // runs both actions and reads back the row each one was supposed to touch.
    run: async (q) =>
      (
        await rows(
          q,
          `SELECT 1 FROM information_schema.columns
            WHERE column_name = 'cherry_started_at'
              AND table_name IN ('checkout_links', 'package_checkout_links',
                                 'training_enrollments')`,
        )
      ).length === 3,
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
      const result = await check.run(q)
      pass = result === true
      // A returned string is a failure that knows what is wrong, and says so instead of
      // falling back to the generic `because`.
      if (typeof result === 'string') error = result
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
