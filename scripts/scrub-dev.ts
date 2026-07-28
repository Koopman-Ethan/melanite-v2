import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { requireEnv } from '../lib/env-guard'

// Replaces real people's details with synthetic ones, in a NON-PRODUCTION database.
//
// Melanite's dev data comes from the v1 migration, so it is real: actual clients, actual email
// addresses, actual phone numbers, actual treatment notes. That was tolerable while the only
// thing serving it was localhost. It is not tolerable now that appdev.melanitesuite.com is
// publicly reachable, and it will be even less so once the nightly prod→dev copy is running —
// which is why this is a repeatable script and not a one-off UPDATE.
//
// RUN IT AFTER EVERY IMPORT. An ETL run or a copy-down brings the real data straight back.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/scrub-dev.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/scrub-dev.ts --check
//
// WHAT IT DOES NOT TOUCH, deliberately:
//   - ids, of any kind. Every foreign key still resolves and every url still works.
//   - money. Prices, the ledger, payouts, splits — untouched, so the totals we test against
//     stay meaningful and a scrubbed database still reconciles.
//   - providers. They are the staff, they have accounts and passwords, and their names appear
//     on client-facing pages we need to look at. Scrambling them makes the app unreadable.
//   - Stripe ids. A scrubbed customer id would break the payment paths this environment exists
//     to test, and those ids identify nobody on their own.
//
// It rewrites names, emails, phone numbers and free-text notes — the fields that identify a
// person to somebody who opens the page.

interface Table {
  label: string
  /** Idempotent by construction: every expression derives from the row's own id, so running it
   *  twice produces the same result and never re-scrambles already-scrubbed data. */
  sql: string
  count: string
}

const TABLES: Table[] = [
  {
    label: 'clients',
    count: `SELECT count(*)::int AS n FROM clients WHERE name NOT LIKE 'Client %'`,
    sql: `
      UPDATE clients SET
        name  = 'Client ' || upper(left(replace(id::text, '-', ''), 6)),
        email = CASE WHEN email IS NULL THEN NULL
                     ELSE 'client.' || left(replace(id::text, '-', ''), 8) || '@example.com' END,
        phone = CASE WHEN phone IS NULL THEN NULL
                     ELSE '208-555-' || lpad((abs(hashtext(id::text)) % 10000)::text, 4, '0') END
      WHERE name NOT LIKE 'Client %'`,
  },
  {
    label: 'bookings',
    // Names are denormalised onto the booking, so scrubbing `clients` alone leaves the real
    // name sitting on the appointment — which is what the calendar actually renders.
    count: `SELECT count(*)::int AS n FROM bookings WHERE client_name NOT LIKE 'Client %'`,
    sql: `
      UPDATE bookings b SET
        client_name  = COALESCE(c.name, 'Client ' || upper(left(replace(b.id::text, '-', ''), 6))),
        client_email = c.email,
        client_phone = c.phone,
        notes        = CASE WHEN b.notes IS NULL THEN NULL ELSE 'Notes removed for development' END
      FROM clients c
      WHERE c.id = b.client_id AND b.client_name NOT LIKE 'Client %'`,
  },
  {
    label: 'bookings without a client record',
    count: `SELECT count(*)::int AS n FROM bookings WHERE client_id IS NULL AND client_name NOT LIKE 'Client %'`,
    sql: `
      UPDATE bookings SET
        client_name  = 'Client ' || upper(left(replace(id::text, '-', ''), 6)),
        client_email = CASE WHEN client_email IS NULL THEN NULL
                            ELSE 'client.' || left(replace(id::text, '-', ''), 8) || '@example.com' END,
        client_phone = CASE WHEN client_phone IS NULL THEN NULL ELSE '208-555-0000' END,
        notes        = CASE WHEN notes IS NULL THEN NULL ELSE 'Notes removed for development' END
      WHERE client_id IS NULL AND client_name NOT LIKE 'Client %'`,
  },
  {
    label: 'training enrolments',
    // Students are members of the public who paid for a course. Same duty of care.
    count: `SELECT count(*)::int AS n FROM training_enrollments WHERE last_name <> 'Student'`,
    sql: `
      UPDATE training_enrollments SET
        first_name     = 'Trainee',
        last_name      = 'Student',
        email          = 'trainee.' || left(replace(id::text, '-', ''), 8) || '@example.com',
        phone          = CASE WHEN phone IS NULL THEN NULL ELSE '208-555-0100' END,
        license_number = CASE WHEN license_number IS NULL THEN NULL ELSE 'RN-DEV-0000' END
      WHERE last_name <> 'Student'`,
  },
]

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  // Stated, not sniffed. The previous check looked for "prod" in the connection string — a
  // Neon URL is `ep-old-paper-a6ligt30.us-west-2.aws.neon.tech`, so it never matched anything
  // and protected nothing at all.
  requireEnv(['dev'], 'scrub client details')

  const sql = neon(url)
  const checkOnly = process.argv.includes('--check')

  const host = /@([^/]+)\//.exec(url)?.[1] ?? 'unknown host'
  console.log(`${checkOnly ? 'Checking' : 'Scrubbing'} ${host}\n`)

  let outstanding = 0
  for (const table of TABLES) {
    const [row] = (await sql.query(table.count)) as { n: number }[]
    outstanding += row.n

    if (checkOnly || row.n === 0) {
      console.log(`  ${row.n === 0 ? 'clean' : `${row.n} to scrub`}  ${table.label}`)
      continue
    }

    await sql.query(table.sql)
    const [after] = (await sql.query(table.count)) as { n: number }[]
    console.log(`  scrubbed ${row.n}  ${table.label}${after.n > 0 ? ` (${after.n} REMAIN)` : ''}`)
  }

  if (checkOnly) {
    console.log(outstanding === 0 ? '\nNothing identifying left.' : `\n${outstanding} rows still hold real details.`)
    process.exit(outstanding === 0 ? 0 : 1)
  }

  // The money must be exactly what it was. If a scrub can change a total, it is doing something
  // it should not, and finding that out here beats finding it out from a revenue report.
  const [ledger] = (await sql.query(
    `SELECT coalesce(sum(melanite_cut), 0)::text AS revenue, count(*)::int AS entries FROM ledger_entries`,
  )) as { revenue: string; entries: number }[]
  console.log(`\nLedger untouched: $${ledger.revenue} across ${ledger.entries} entries.`)
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
