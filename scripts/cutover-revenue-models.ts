import '../envConfig'

import { sql } from 'drizzle-orm'

import { describeDatabase } from '../lib/env-guard'
import { db } from './db'

// Moving every provider onto the rental model, on one of two fee bases.
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
// Everybody active and not `house` becomes `rental`. The difference is the BASIS:
//
//   tier            the published schedule price for the service. Everybody.
//   half_own_price  half of what the provider charges for it. Leyla, Brittany and Karly.
//
// The three were grandfathered onto the 50/50 on 9 October ("I'm going to lose those girls if I
// don't allow them the 50/50"). On 14 October Keoni took Connect away from them too, so they
// stopped being PAID half and started OWING half instead. Same arrangement, opposite direction,
// and the only thing left that distinguishes them.
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

/** The three billed half their own price, by email. Keoni's list of 9 October 2026.
 *
 *  They used to KEEP half of what their client paid Melanite. From 14 October they bill the
 *  client directly and PAY Melanite the other half — the same split, from the opposite side. The
 *  list is unchanged; what it means has inverted.
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
  rent_basis: string
  booking_enabled: boolean
  card_last4: string | null
}

async function main() {
  const apply = process.argv.includes('--apply')

  console.log(`${describeDatabase()}`)
  console.log(`Mode: ${apply ? 'APPLY — models will be changed' : 'DRY RUN'}\n`)

  const { rows } = await db.execute<Row>(sql`
    SELECT id, email, first_name || ' ' || last_name AS name, revenue_model, rent_basis,
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

  const halfPrice: Row[] = []
  const toRental: Row[] = []
  const settled: Row[] = []

  for (const r of all) {
    if (r.revenue_model === 'house') continue
    const grandfathered = (GRANDFATHERED as readonly string[]).includes(r.email)
    const wantBasis = grandfathered ? 'half_own_price' : 'tier'

    if (r.revenue_model === 'rental' && r.rent_basis === wantBasis) settled.push(r)
    else if (grandfathered) halfPrice.push(r)
    else toRental.push(r)
  }

  console.log('Rent billed as half their own price, by arrangement:')
  if (halfPrice.length === 0 && settled.filter((r) => r.rent_basis === 'half_own_price').length === 0) {
    console.log('  (nobody — check the list above against Keoni’s)')
  }
  for (const r of halfPrice) {
    console.log(
      `  half     ${r.name.padEnd(22)} ${r.revenue_model}/${r.rent_basis} → rental/half_own_price`,
    )
  }

  if (settled.length > 0) {
    console.log('\nAlready correct:')
    for (const r of settled) console.log(`  ok       ${r.name.padEnd(22)} ${r.rent_basis}`)
  }

  console.log('\nRent billed at the published tier price:')
  if (toRental.length === 0) console.log('  (nobody)')
  for (const r of toRental) {
    // A provider who can book and has no card cannot book once they are on rent. Worth seeing
    // here rather than discovering it when they try.
    const note = r.booking_enabled
      ? r.card_last4
        ? `card ••${r.card_last4}`
        : '** CAN BOOK, NO CARD — will be blocked until they add one'
      : 'booking not enabled'
    console.log(`  tier     ${r.name.padEnd(22)} ${r.revenue_model} → rental   ${note}`)
  }

  // The three need a card now too, and that is new for them — they were never charged anything
  // before. Said loudly because it is the one thing that stops them working on the day.
  const halfNoCard = [...halfPrice, ...settled.filter((r) => r.rent_basis === 'half_own_price')]
    .filter((r) => r.booking_enabled && !r.card_last4)
  if (halfNoCard.length > 0) {
    console.log('\n** These owe rent now and have no card on file:')
    for (const r of halfNoCard) console.log(`     ${r.name}`)
  }

  const changing = halfPrice.length + toRental.length
  if (!apply) {
    console.log(`\n${changing} provider(s) would change. Re-run with --apply.`)
    return
  }

  if (halfPrice.length > 0) {
    await db.execute(sql`
      UPDATE providers SET revenue_model = 'rental', rent_basis = 'half_own_price'
       WHERE id = ANY(${sql.raw(`ARRAY['${halfPrice.map((r) => r.id).join("','")}']::uuid[]`)})
    `)
  }
  if (toRental.length > 0) {
    await db.execute(sql`
      UPDATE providers SET revenue_model = 'rental', rent_basis = 'tier'
       WHERE id = ANY(${sql.raw(`ARRAY['${toRental.map((r) => r.id).join("','")}']::uuid[]`)})
    `)
  }

  console.log(`\n${changing} provider(s) changed.`)
  console.log('\nEverybody now pays Melanite rather than being paid by it. The three keep their')
  console.log('own price list, because half of it is what they owe — but no client money, no')
  console.log('Connect account and no payout ever reaches them through Melanite again.')
}


main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
})
