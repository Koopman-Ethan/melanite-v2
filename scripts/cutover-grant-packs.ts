import '../envConfig'

import { sql } from 'drizzle-orm'

import { tierForService } from '@/lib/rental-fees'
import { grantPack } from '@/lib/rental/packs'

import { currentEnv, describeDatabase } from '../lib/env-guard'
import { db } from './db'

// Honouring sessions clients already paid for, after the model changes under them.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/cutover-grant-packs.ts            (dry run)
//   npx tsx --tsconfig scripts/tsconfig.json scripts/cutover-grant-packs.ts --apply
//
// THE PROBLEM THIS SOLVES
//
// Under the split model a client could buy six sessions up front; Melanite took its half at the
// point of sale and the provider worked the sessions off over the following months. At cutover
// Melanite stops taking a share of anything and starts charging the provider rent per session —
// so every unworked session becomes one the provider must now pay rent on, out of money Melanite
// has already been paid half of. Charging for those would be charging twice.
//
// The fix is a comped pack: the outstanding sessions, granted at zero cost, drawn down by the
// booking path exactly like a pack they bought. One mechanism, not a special case in the billing
// path that somebody has to remember to remove afterwards.
//
// COUNTS ARE COMPUTED, NEVER TYPED. The number was 11 when this was first discussed and 10 two
// weeks later, because a session got worked in between. It will be different again on the day.
// Anything hardcoded here would be wrong by the time it ran.
//
// SAFE IN PRODUCTION — that is the point of it, so there is no `requireEnv` guard. The protection
// is instead that it does nothing without `--apply`, prints the database it is pointed at, and
// refuses to run twice: every pack it creates carries `MARKER` in its note, and a provider who
// already has one is skipped.

/** Stamped into every note so a second run can recognise its own work. */
const MARKER = 'cutover:prepaid-honoured'

interface Outstanding {
  providerId: string
  providerName: string
  serviceName: string
  sessions: number
}

async function outstandingSessions(): Promise<Outstanding[]> {
  const rows = await db.execute<{
    provider_id: string
    provider_name: string
    service_name: string
    sessions: number
  }>(sql`
    SELECT p.id                                         AS provider_id,
           p.first_name || ' ' || p.last_name           AS provider_name,
           s.name                                       AS service_name,
           sum(cpi.qty_total - cpi.qty_used)::int       AS sessions
      FROM client_packages cp
      JOIN client_package_items cpi ON cpi.client_package_id = cp.id
      JOIN services s               ON s.id = cpi.service_id
      JOIN providers p              ON p.id = cp.provider_id
     WHERE cp.status = 'active'
       AND cpi.qty_used < cpi.qty_total
     GROUP BY 1, 2, 3
     HAVING sum(cpi.qty_total - cpi.qty_used) > 0
     ORDER BY 2, 3
  `)

  return (rows.rows ?? []).map((r) => ({
    providerId: r.provider_id,
    providerName: r.provider_name,
    serviceName: r.service_name,
    sessions: Number(r.sessions),
  }))
}

/** Prepaid credit is a DOLLAR balance, not sessions, so it cannot be converted into a pack
 *  without someone deciding how many sessions a dollar is worth. Reported, never guessed at. */
async function outstandingPrepaid(): Promise<{ name: string; amount: string }[]> {
  const rows = await db.execute<{ name: string; amount: string }>(sql`
    SELECT p.first_name || ' ' || p.last_name AS name,
           sum(pb.remaining_amount)::text              AS amount
      FROM prepaid_balances pb
      JOIN providers p ON p.id = pb.provider_id
     WHERE pb.remaining_amount > 0 AND pb.status = 'active'
     GROUP BY 1
     ORDER BY 1
  `)
  return rows.rows ?? []
}

async function alreadyGranted(): Promise<Set<string>> {
  const rows = await db.execute<{ provider_id: string; tier_key: string }>(sql`
    SELECT provider_id, tier_key FROM provider_packs WHERE note LIKE ${'%' + MARKER + '%'}
  `)
  return new Set((rows.rows ?? []).map((r) => `${r.provider_id}:${r.tier_key}`))
}

async function main() {
  const apply = process.argv.includes('--apply')

  console.log(`Database: ${describeDatabase()} (MELANITE_ENV=${currentEnv() ?? 'unset'})`)
  console.log(apply ? 'Mode: APPLY — packs will be created\n' : 'Mode: dry run — nothing written\n')

  const outstanding = await outstandingSessions()
  if (outstanding.length === 0) {
    console.log('No outstanding client package sessions. Nothing to honour.')
    return
  }

  // Group by tier, because a pack is a tier's worth of laser time. Two services in the same
  // bracket become one pack rather than two the provider has to think about.
  const byTier = new Map<string, { providerName: string; sessions: number; from: string[] }>()
  const blocked: Outstanding[] = []

  for (const row of outstanding) {
    const tier = tierForService(row.serviceName)
    if (!tier) {
      // A service the fee schedule does not price. Granting nothing would quietly drop sessions a
      // client paid for; guessing a tier would pick a price nobody agreed. So it stops here.
      blocked.push(row)
      continue
    }

    const key = `${row.providerId}:${tier.key}`
    const entry = byTier.get(key) ?? { providerName: row.providerName, sessions: 0, from: [] }
    entry.sessions += row.sessions
    entry.from.push(`${row.sessions} × ${row.serviceName}`)
    byTier.set(key, entry)
  }

  const granted = await alreadyGranted()

  console.log('Outstanding sessions to honour:')
  for (const [key, entry] of byTier) {
    const [, tierKey] = key.split(':')
    const done = granted.has(key) ? '  [already granted — skipping]' : ''
    console.log(`  ${entry.providerName.padEnd(22)} ${tierKey.padEnd(14)} ${String(entry.sessions).padStart(3)} sessions${done}`)
    console.log(`  ${' '.repeat(22)} from: ${entry.from.join(', ')}`)
  }

  if (blocked.length > 0) {
    console.log('\nCANNOT BE HONOURED — no rental tier for these services:')
    for (const row of blocked) {
      console.log(`  ${row.providerName.padEnd(22)} ${row.sessions} × ${row.serviceName}`)
    }
    console.log(
      '\n  These sessions were sold to clients and are still owed. Price the service in\n' +
        '  lib/rental-fees.ts before cutover, or settle them with the provider directly.',
    )
  }

  const prepaid = await outstandingPrepaid()
  if (prepaid.length > 0) {
    console.log('\nUNCONVERTED — prepaid dollar balances, which are not sessions:')
    for (const row of prepaid) {
      console.log(`  ${row.name.padEnd(22)} $${row.amount}`)
    }
    console.log(
      '\n  A dollar balance cannot become a pack without deciding what a dollar buys.\n' +
        '  Needs a decision from Keoni, not a default from this script.',
    )
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to create the packs above.')
    return
  }

  console.log('')
  for (const [key, entry] of byTier) {
    const [providerId, tierKey] = key.split(':')
    if (granted.has(key)) {
      console.log(`  skipped  ${entry.providerName} — ${tierKey} already granted`)
      continue
    }

    const out = await grantPack({
      providerId,
      tierKey,
      sessions: entry.sessions,
      note: `${MARKER} — ${entry.sessions} session(s) already paid for by clients before the rental model: ${entry.from.join(', ')}`,
    })

    if ('error' in out) {
      console.error(`  FAILED   ${entry.providerName} — ${tierKey}: ${out.error}`)
      process.exitCode = 1
      continue
    }
    console.log(`  granted  ${entry.providerName} — ${entry.sessions} × ${tierKey} (${out.packId})`)
  }

  if (blocked.length > 0) {
    // Loud, and non-zero, because the run was incomplete even though every pack it could create
    // was created. A green exit here would mean "all sessions honoured", which is not true.
    console.error('\nFinished with sessions that could not be honoured — see above.')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
