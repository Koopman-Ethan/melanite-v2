import '../envConfig'

import { sql } from 'drizzle-orm'

import { describeDatabase } from '../lib/env-guard'
import { db } from './db'

// Moving providers onto the rental model, and leaving the grandfathered three where they are.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/cutover-revenue-models.ts            (dry run)
//   npx tsx --tsconfig scripts/tsconfig.json scripts/cutover-revenue-models.ts --apply
//
// WHAT THIS IS FOR
//
// `provider_revenue_model` gained a third value, `rental`, and its default changed to it — so
// anybody invited from now on lands in the right place without anybody deciding. This moves the
// people who already existed.
//
// Everybody active and not `house` becomes `rental`, EXCEPT the three Keoni grandfathered onto
// the 50/50 split on 9 October 2026: Leyla, Brittany and Karly. Her reasoning, verbatim: "I'm
// going to lose those girls if I don't allow them the 50/50." They are already `split`, which is
// the arrangement they keep, so for them this script does nothing at all — the change moves
// everybody else around them.
//
// WHY THE THREE ARE NAMED HERE AND NOT IN THE MIGRATION
//
// A migration that names living people is wrong the moment one of them leaves, and it cannot be
// corrected without a second migration contradicting the first. A script can be re-read, argued
// with, and run again. The schema change is structural and belongs in `0039`; who is on which
// arrangement is a business fact and belongs here.
//
// SAFE IN PRODUCTION, and meant to be run there — no `requireEnv` guard, for the same reason
// `cutover-grant-sessions.ts` has none. The protection is that it does nothing without
// `--apply`, prints the database it is pointed at, names every provider it would move, and is
// idempotent: a provider already on the right model is reported as such and left alone.
//
// IT REFUSES rather than guessing if a grandfathered email is not found. A typo there would
// silently move somebody onto rent who was promised a share, which is the one outcome worth
// failing loudly over.

/** The 50/50 three, by email. Keoni's list of 9 October 2026.
 *
 *  Email rather than id so this is readable by somebody checking it against her message, and so
 *  it survives a database restored from a different environment. */
const GRANDFATHERED = [
  'leykonjuhovac@gmail.com', // Leyla Konjuhovac
  'bmayesthetics@gmail.com', // Brittany Phillips
  'karlydettorre@gmail.com', // Karly Dettorre
] as const

interface Row extends Record<string, unknown> {
  id: string
  email: string
  name: string
  revenue_model: string
  booking_enabled: boolean
  card_last4: string | null
}

async function main() {
  const apply = process.argv.includes('--apply')

  console.log(`${describeDatabase()}`)
  console.log(`Mode: ${apply ? 'APPLY — models will be changed' : 'DRY RUN'}\n`)

  const { rows } = await db.execute<Row>(sql`
    SELECT id, email, first_name || ' ' || last_name AS name, revenue_model,
           booking_enabled, billing_card_last4 AS card_last4
      FROM providers
     WHERE status = 'active'
     ORDER BY first_name
  `)

  const all = rows ?? []

  // Fail before touching anything if the list does not match reality. A grandfathered provider
  // who cannot be found is either a typo or somebody who has left, and both need a human.
  const missing = GRANDFATHERED.filter((e) => !all.some((r) => r.email === e))
  if (missing.length > 0) {
    console.error('These grandfathered emails match no active provider:')
    for (const e of missing) console.error(`  ${e}`)
    console.error('\nFix the list or the data before running. Refusing to move anybody.')
    process.exitCode = 1
    return
  }

  const keep: Row[] = []
  const move: Row[] = []
  const already: Row[] = []

  for (const r of all) {
    if (r.revenue_model === 'house') continue
    if ((GRANDFATHERED as readonly string[]).includes(r.email)) keep.push(r)
    else if (r.revenue_model === 'rental') already.push(r)
    else move.push(r)
  }

  console.log('Staying on the 50/50 split, by arrangement:')
  for (const r of keep) {
    const wrong = r.revenue_model !== 'split' ? `  ** on '${r.revenue_model}', expected 'split'` : ''
    console.log(`  keep     ${r.name.padEnd(22)} ${r.revenue_model}${wrong}`)
  }

  if (already.length > 0) {
    console.log('\nAlready on rental:')
    for (const r of already) console.log(`  ok       ${r.name}`)
  }

  console.log('\nMoving to the rental model:')
  if (move.length === 0) console.log('  (nobody)')
  for (const r of move) {
    // A provider who can book and has no card cannot book once they are on rent. Worth seeing
    // here rather than discovering it when they try.
    const note = r.booking_enabled
      ? r.card_last4
        ? `card ••${r.card_last4}`
        : '** CAN BOOK, NO CARD — will be blocked until they add one'
      : 'booking not enabled'
    console.log(`  move     ${r.name.padEnd(22)} ${r.revenue_model} → rental   ${note}`)
  }

  if (!apply) {
    console.log(`\n${move.length} provider(s) would move. Re-run with --apply.`)
    return
  }

  if (move.length > 0) {
    await db.execute(sql`
      UPDATE providers SET revenue_model = 'rental'
       WHERE id = ANY(${sql.raw(`ARRAY['${move.map((r) => r.id).join("','")}']::uuid[]`)})
    `)
  }

  console.log(`\n${move.length} provider(s) moved to rental. ${keep.length} left on 50/50.`)
  console.log('\nThe three on 50/50 keep their service price lists, their Connect payouts and')
  console.log('the client-payment screens. Everybody else now pays rent per session.')
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
