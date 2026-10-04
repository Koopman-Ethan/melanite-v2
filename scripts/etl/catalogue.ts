import { neon } from '@neondatabase/serverless'

import '../../envConfig'
import { describeDatabase, requireEnv } from '../../lib/env-guard'

// The service catalogue changes that an ETL run would otherwise destroy.
//
// `load.ts` TRUNCATEs `services` and repopulates it from the v1 export. That is correct — the
// catalogue is v1 data and the loader owns it — but it means anything v2 has decided about the
// catalogue since is wiped on every import.
//
// Migration 0024 is exactly that: it added twelve laser hair removal body areas, retired the
// four size brackets, and filed everything under a category. Run the ETL afterwards and prod
// ends up with v1's four sizes, active, no body areas and every category null — and because a
// migration runs once, 0024 would never repair it. Nothing would fail. The booking form would
// simply offer Small/Medium/Large again, which is what it did for two years, so nobody would
// think to look.
//
// So the catalogue decisions live here instead, in a script that is re-runnable by design and
// runs AFTER every import:
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/catalogue.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/catalogue.ts --check
//
// Idempotent. Everything is keyed on `services.name`, which has no unique index, so inserts are
// guarded with NOT EXISTS rather than ON CONFLICT. Running it twice changes nothing; running it
// on a database that never had the ETL applied also changes nothing beyond filling in the gaps.
//
// This is allowed in BOTH environments — it is the same decision in each, and a catalogue that
// differs between dev and prod is a bug you only find in production.

const LHR = 'Laser hair removal'

/** Keoni's areas, 2026-07-31. Duration is [suggested, min, max].
 *
 *  She gave a pair for each: what it typically takes, and the longest a provider should book.
 *  Those are `suggested` and `max` — NOT both the default, which would block 90 minutes of
 *  laser for every back and cost most of a treatment slot a day.
 *
 *  The ones she did not cover are marked. They come from the bracket the old sizes put them in,
 *  so they can be corrected without re-deriving which ones were guessed.
 *
 *  Chin was added 2026-08-28, after that list, at the client's request. It was proposed on the
 *  upper lip bracket — comparable area, same laser time — and Keoni confirmed 15/15/30 the same
 *  day, so it counts as hers rather than a guess. */
const AREAS: [name: string, suggested: number, min: number, max: number, fromKeoni: boolean][] = [
  ['Upper Lip', 15, 15, 30, true],
  ['Chin', 15, 15, 30, true], // added 2026-08-28, confirmed by Keoni the same day
  ['Full Face', 15, 15, 30, true],
  ['Underarms', 15, 15, 30, true],
  ['Half Arms', 30, 15, 60, false], // proposed: old Medium bracket, with half leg
  ['Full Arms', 45, 30, 60, false], // proposed: between half arms and full legs
  ['Chest', 60, 45, 90, true],
  ['Abs', 60, 45, 90, true],
  ['Back', 60, 45, 90, true],
  ['Bikini', 30, 15, 60, false], // proposed: smaller than a Brazilian, timed the same
  ['Brazilian', 30, 15, 60, true],
  ['Half Legs', 30, 15, 60, true],
  ['Full Legs', 60, 45, 90, true],
]

const SKIN = 'Skin treatments'

/** Skin-treatment areas, added 2026-10-03.
 *
 *  The rental fee schedule prices IPL and ClearLift BY AREA — "people charge different prices
 *  for each area", in Keoni's words — but the catalogue carried one generic `IPL` with the area
 *  typed into `bookings.treatmentArea` as free text. A free-text area cannot be priced, so the
 *  service had no rental fee and could not be booked at all once the rental model landed.
 *
 *  The same split migration 0024 did for hair removal, and for the same reason: an area is a
 *  different treatment at a different price, so it is a different service.
 *
 *  Durations follow the parent service, scaled down for the smaller areas. Only the full-face
 *  ones are inherited rather than proposed; the rest are marked, exactly as the hair removal
 *  areas are, so a guess can be corrected without re-deriving which ones were guessed.
 *
 *  `ClearLift` itself is the full-face treatment and keeps its name — renaming a service five
 *  providers already offer is a decision for Keoni, not a tidy-up. `Carbon Laser Treatment`
 *  stays its own service at the same price, and `ClearLift Lip Plumper` is the guide's "Lip". */
const SKIN_AREAS: [
  name: string,
  suggested: number,
  min: number,
  max: number,
  colour: string,
  fromKeoni: boolean,
][] = [
  ['IPL — Full Face', 70, 45, 90, '#ce93d8', true], // the old generic IPL's own durations
  ['IPL — Neck', 30, 15, 45, '#ce93d8', false],
  ['IPL — Chest', 45, 30, 60, '#ce93d8', false],
  ['IPL — Hands', 25, 15, 30, '#ce93d8', false],
  ['ClearLift — Neck', 30, 15, 45, '#a5d6a7', false],
  ['ClearLift — Hands', 25, 15, 30, '#a5d6a7', false],
]

const RETIRED = [
  'Laser Hair Removal (XSmall)',
  'Laser Hair Removal (Small)',
  'Laser Hair Removal (Medium)',
  'Laser Hair Removal (Large)',
  // Replaced by the four area services above. Retired rather than deleted, like the hair
  // removal brackets: three past appointments reference it through `provider_services`, and
  // the record of what a client was actually treated for has to survive.
  'IPL',
]

async function main() {
  // Deliberately allowed against production: this IS a production change, and running it only
  // on dev is how the two catalogues drift apart.
  requireEnv(['dev', 'prod'], 'reconcile the service catalogue')

  const checkOnly = process.argv.includes('--check')
  const sql = neon(process.env.DATABASE_URL!)
  console.log(`${checkOnly ? 'Checking' : 'Reconciling'} ${describeDatabase()}\n`)

  let changes = 0

  // ---- the twelve areas ----
  for (const [area, suggested, min, max, fromKeoni] of AREAS) {
    const name = `Laser Hair Removal — ${area}`
    const [existing] = (await sql.query(`SELECT id FROM services WHERE name = $1`, [name])) as {
      id: string
    }[]

    if (existing) continue

    changes += 1
    const note = fromKeoni ? '' : '  (duration proposed, not from Keoni)'
    if (checkOnly) {
      console.log(`  missing  ${name}${note}`)
      continue
    }

    await sql.query(
      `INSERT INTO services (name, category, suggested_duration_mins, min_duration_mins,
                             max_duration_mins, package_eligible, advanced_tier_required,
                             color_hex, active)
       VALUES ($1, $2, $3, $4, $5, true, false, '#B8965A', true)`,
      [name, LHR, suggested, min, max],
    )
    console.log(`  added    ${name}${note}`)
  }

  // ---- the skin-treatment areas ----
  for (const [name, suggested, min, max, colour, fromKeoni] of SKIN_AREAS) {
    const [existing] = (await sql.query(`SELECT id FROM services WHERE name = $1`, [name])) as {
      id: string
    }[]

    if (existing) continue

    changes += 1
    const note = fromKeoni ? '' : '  (duration proposed, not from Keoni)'
    if (checkOnly) {
      console.log(`  missing  ${name}${note}`)
      continue
    }

    await sql.query(
      `INSERT INTO services (name, category, suggested_duration_mins, min_duration_mins,
                             max_duration_mins, package_eligible, advanced_tier_required,
                             color_hex, active)
       VALUES ($1, $2, $3, $4, $5, true, false, $6, true)`,
      [name, SKIN, suggested, min, max, colour],
    )
    console.log(`  added    ${name}${note}`)
  }

  // ---- retire what has been replaced ----
  //
  // Retired, never deleted: `provider_services.service_id` is ON DELETE RESTRICT and
  // appointments reference the provider service, so removing these would either fail or destroy
  // the record of what a past client was actually treated for.
  const stillLive = (await sql.query(
    `SELECT name FROM services WHERE name = ANY($1) AND active`,
    [RETIRED],
  )) as { name: string }[]

  for (const row of stillLive) {
    changes += 1
    if (checkOnly) {
      console.log(`  bookable ${row.name} — should be retired`)
    } else {
      await sql.query(`UPDATE services SET active = false WHERE name = $1`, [row.name])
      console.log(`  retired  ${row.name}`)
    }
  }

  // ---- file everything under a group ----
  //
  // A null category renders last rather than nowhere, so an unfiled service is never lost — but
  // an entire catalogue of them means the dropdowns silently stop grouping.
  const unfiled = (await sql.query(
    `SELECT name FROM services WHERE category IS NULL`,
  )) as { name: string }[]

  if (unfiled.length > 0) {
    changes += unfiled.length
    if (checkOnly) {
      console.log(`  unfiled  ${unfiled.length} service(s) have no category`)
    } else {
      await sql.query(
        `UPDATE services SET category = CASE
           WHEN name LIKE 'Laser Hair Removal%' THEN $1
           WHEN name LIKE 'Tattoo Removal%'     THEN 'Tattoo removal'
           ELSE 'Skin treatments' END
         WHERE category IS NULL`,
        [LHR],
      )
      console.log(`  filed    ${unfiled.length} service(s) into a category`)
    }
  }

  if (changes === 0) {
    console.log('  Catalogue is already correct.')
    return
  }

  if (checkOnly) {
    console.log(`\n${changes} thing(s) to fix. Re-run without --check.`)
    process.exitCode = 1
    return
  }

  console.log(`\n${changes} change(s) applied.`)
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
