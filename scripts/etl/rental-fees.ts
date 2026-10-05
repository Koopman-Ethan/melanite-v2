import { neon } from '@neondatabase/serverless'

import '../../envConfig'
import { describeDatabase, requireEnv } from '../../lib/env-guard'
import { RENTAL_TIERS } from '../../lib/rental-fees'

// Seeds the first published fee schedule from the code constants.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/rental-fees.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/rental-fees.ts --check
//
// WHY THIS EXISTS, and why it is a script rather than a migration: `scripts/etl/load.ts --force`
// does `TRUNCATE ... CASCADE`, and a migration runs once. The same trap `scripts/etl/catalogue.ts`
// was written for — migration 0024 made a catalogue decision that an import silently undid, and
// nothing failed, so nobody looked. This follows it exactly.
//
// IT ONLY EVER SEEDS. If a schedule has already been published it does nothing, because from
// that point the database is the source of truth and the constants are only a fallback for a
// tier added in code later. Overwriting Keoni's prices with whatever happens to be in the repo
// is the one thing this must never do.
//
// Allowed in BOTH environments, like the catalogue: it is the same starting point in each, and
// a fee schedule that differs between dev and prod is a bug you find in production.

async function main() {
  requireEnv(['dev', 'prod'], 'seed the rental fee schedule')

  const checkOnly = process.argv.includes('--check')
  const sql = neon(process.env.DATABASE_URL!)
  console.log(`${checkOnly ? 'Checking' : 'Seeding'} ${describeDatabase()}\n`)

  const [latest] = (await sql.query(
    `SELECT version, published_at, note FROM rental_fee_schedules ORDER BY version DESC LIMIT 1`,
  )) as { version: number; published_at: string; note: string | null }[]

  if (latest) {
    console.log(`  Schedule v${latest.version} already published ${latest.published_at}.`)

    // The one thing still worth saying: a tier added in code since the last publish is being
    // priced from the seed, which works but means Keoni has never seen it.
    const priced = (await sql.query(
      `SELECT tier_key FROM rental_fee_entries WHERE schedule_version = $1`,
      [latest.version],
    )) as { tier_key: string }[]

    const have = new Set(priced.map((r) => r.tier_key))
    const unpublished = RENTAL_TIERS.filter((t) => !have.has(t.key))

    if (unpublished.length === 0) {
      console.log('  Every tier is priced by it. Nothing to do.')
      return
    }

    console.log('\n  These tiers are newer than the published schedule and fall back to code:')
    for (const tier of unpublished) {
      console.log(`    ${tier.key.padEnd(18)} $${(tier.singleCents / 100).toFixed(2)}  ${tier.label}`)
    }
    console.log(
      '\n  They are bookable at the seeded price. Publishing from the admin pricing page\n' +
        '  writes every tier and clears this.',
    )
    return
  }

  if (checkOnly) {
    console.log(`  No schedule published. Would seed v1 with ${RENTAL_TIERS.length} tiers.`)
    process.exitCode = 1
    return
  }

  // `published_by` stays null: this version was not a decision anybody made, it is the schedule
  // the code shipped with. Every later version names the admin who published it.
  await sql.query(
    `INSERT INTO rental_fee_schedules (version, published_by, note)
     VALUES (1, NULL, $1)`,
    ["Seeded from Keoni's pricing guide, revision of 3 October 2026."],
  )

  for (const tier of RENTAL_TIERS) {
    await sql.query(
      `INSERT INTO rental_fee_entries
         (schedule_version, tier_key, single_cents, suggested_low_cents, suggested_high_cents)
       VALUES (1, $1, $2, $3, $4)`,
      [tier.key, tier.singleCents, tier.suggestedLowCents, tier.suggestedHighCents],
    )
    console.log(`  priced   ${tier.key.padEnd(18)} $${(tier.singleCents / 100).toFixed(2)}`)
  }

  console.log(`\nSchedule v1 published with ${RENTAL_TIERS.length} tiers.`)
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
