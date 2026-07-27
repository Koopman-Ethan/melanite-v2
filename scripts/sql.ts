// Run ad-hoc SQL against Neon from the terminal.
//
//   npm run db:sql "select source, sum(melanite_cut) from ledger_entries group by 1"
//   npm run db:sql -- --file scripts/queries/revenue.sql
//
// Results print as a table. Multi-statement input is sent as-is, so a trailing semicolon is
// fine but only the last statement's rows are shown.

import { readFileSync } from 'node:fs'

import { neon } from '@neondatabase/serverless'

import '../envConfig'

function usage(): never {
  console.error('usage: npm run db:sql "<sql>"   |   npm run db:sql -- --file <path.sql>')
  process.exit(1)
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set — check .env.local')

  const args = process.argv.slice(2)
  if (args.length === 0) usage()

  const fileFlag = args.indexOf('--file')
  const query =
    fileFlag !== -1
      ? readFileSync(args[fileFlag + 1] ?? usage(), 'utf8')
      : args.join(' ')

  if (!query.trim()) usage()

  // `sql.query()` rather than the tagged template — the template form would treat an
  // interpolated string as a parameter, and here the whole statement is the input.
  const sql = neon(process.env.DATABASE_URL)
  const data = (await sql.query(query)) as unknown as Record<string, unknown>[]

  if (!Array.isArray(data) || data.length === 0) {
    console.log('(no rows)')
    return
  }

  console.table(data)
  console.log(`${data.length} row${data.length === 1 ? '' : 's'}`)
}

main().catch((err) => {
  // Postgres errors carry the useful detail in `detail`/`hint`, which the message omits.
  console.error(err.message)
  if (err.detail) console.error('detail:', err.detail)
  if (err.hint) console.error('hint:  ', err.hint)
  process.exitCode = 1
})
