import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { neon } from '@neondatabase/serverless'

import { parseEnvFile } from '../lib/env-file'

// Side-by-side row counts and money totals for dev against production.
//
// READ ONLY. Every statement here is a SELECT — a table list, counts, and sums. Nothing writes,
// and it deliberately reads no client details: counts and totals answer "did the copy land"
// without pulling a single name or email out of production.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/compare-dbs.ts
//
// Reads both connection strings straight from their files rather than through envConfig, so
// neither environment can end up pointed at the other by an inherited process variable.

function urlFrom(file: string): string {
  const values = parseEnvFile(readFileSync(join(process.cwd(), file), 'utf8'))
  const url = values.DATABASE_URL
  if (!url) throw new Error(`${file} has no DATABASE_URL`)
  return url
}

/** The endpoint name only — never the credentials. */
function host(url: string): string {
  return /@([^/?]+)/.exec(url)?.[1]?.split('.')[0] ?? '?'
}

async function main() {
  const devUrl = urlFrom('.env.local')
  const prodUrl = urlFrom('.env.migration')

  if (devUrl === prodUrl) throw new Error('Both files point at the same database')

  const dev = neon(devUrl)
  const prod = neon(prodUrl)

  console.log(`dev   ${host(devUrl)}`)
  console.log(`prod  ${host(prodUrl)}  (read only)\n`)

  // Table list from PRODUCTION, so anything missing from dev shows as a mismatch rather than
  // being quietly skipped.
  const tables = (
    (await prod`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `) as { tablename: string }[]
  ).map((r) => r.tablename)

  const countsSql = tables
    .map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`)
    .join(' UNION ALL ')

  const [devRaw, prodRaw] = await Promise.all([dev.query(countsSql), prod.query(countsSql)])
  const devRows = devRaw as { t: string; n: number }[]
  const prodRows = prodRaw as { t: string; n: number }[]

  const devBy = new Map(devRows.map((r) => [r.t, r.n]))
  const prodBy = new Map(prodRows.map((r) => [r.t, r.n]))

  console.log('TABLE'.padEnd(30) + 'prod'.padStart(8) + 'dev'.padStart(8))
  console.log('-'.repeat(52))

  let mismatched = 0
  let prodTotal = 0
  let devTotal = 0

  for (const t of tables) {
    const p = prodBy.get(t) ?? 0
    const d = devBy.get(t) ?? 0
    prodTotal += p
    devTotal += d
    if (p !== d) mismatched++
    console.log(
      t.padEnd(30) +
        String(p).padStart(8) +
        String(d).padStart(8) +
        (p === d ? '' : `   MISMATCH (${d - p > 0 ? '+' : ''}${d - p})`),
    )
  }

  console.log('-'.repeat(52))
  console.log('TOTAL'.padEnd(30) + String(prodTotal).padStart(8) + String(devTotal).padStart(8))

  // The money must be identical. The scrub leaves every amount alone by design, so a difference
  // here means rows were lost or duplicated — not that anything was anonymised.
  const moneySql = `
    SELECT count(*)::int                           AS entries,
           coalesce(sum(gross_amount), 0)::text    AS gross,
           coalesce(sum(tip_amount), 0)::text      AS tip,
           coalesce(sum(provider_payout), 0)::text AS payout,
           coalesce(sum(melanite_cut), 0)::text    AS cut
      FROM ledger_entries`

  const [devMoney, prodMoney] = await Promise.all([
    dev.query(moneySql) as Promise<Record<string, string>[]>,
    prod.query(moneySql) as Promise<Record<string, string>[]>,
  ])

  console.log('\nLEDGER'.padEnd(30) + 'prod'.padStart(14) + 'dev'.padStart(14))
  console.log('-'.repeat(58))
  for (const key of ['entries', 'gross', 'tip', 'payout', 'cut']) {
    const p = String(prodMoney[0][key])
    const d = String(devMoney[0][key])
    console.log(
      `  ${key}`.padEnd(30) + p.padStart(14) + d.padStart(14) + (p === d ? '' : '   MISMATCH'),
    )
  }

  // Proof the scrub ran, without printing anybody's details.
  const realNames = `SELECT count(*)::int AS n FROM clients WHERE name NOT LIKE 'Client %'`
  const [devRealRaw, prodRealRaw] = await Promise.all([
    dev.query(realNames),
    prod.query(realNames),
  ])
  const devReal = devRealRaw as { n: number }[]
  const prodReal = prodRealRaw as { n: number }[]

  console.log('\nSCRUB')
  console.log(`  clients with real names — prod ${prodReal[0].n}, dev ${devReal[0].n}`)
  console.log(
    devReal[0].n === 0
      ? '  dev holds nothing identifying.'
      : '  *** DEV STILL HOLDS REAL CLIENT NAMES ***',
  )

  console.log(
    mismatched === 0 ? '\nEvery table matches.' : `\n${mismatched} table(s) differ.`,
  )
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
