import { neon } from '@neondatabase/serverless'

import '../envConfig'
import { requireEnv } from '../lib/env-guard'
import { TABLES, scrubSql } from './scrub-sql'

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
//   npx tsx --tsconfig scripts/tsconfig.json scripts/scrub-dev.ts --print-sql
//
// This is the RUNNER. What actually counts as identifying — and the equally deliberate list of
// what is left alone — lives in `scrub-sql.ts`, because `refresh-dev.ts` needs the same
// statements inside its own transaction and neither may hold a second copy.
//
// The nightly copy scrubs as part of loading, so on an ordinary day this has nothing to do.
// It stays because a hand-run ETL, a restored backup or a one-off import all bring the real
// data back, and none of those go through the nightly path.


async function main() {
  // Prints and exits, touching no database. Deliberately before every check below, because
  // there is nothing to be careful about: this reads no data and writes none.
  if (process.argv.includes('--print-sql')) {
    console.log(scrubSql())
    return
  }

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
