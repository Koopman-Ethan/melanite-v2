// What the import will bring across, and what it will leave behind.
//
// Run BEFORE a migration, read the output, then migrate:
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/etl/manifest.ts
//
// It reads the staged v1 export and reports every row it would keep or drop, with the reason.
// It writes nothing and touches no database.
//
// The point is that a migration should be boring. Everything it does should have been visible
// beforehand, so afterwards there is nothing to discover — no "where did that appointment go",
// no "why is there a Test Test on the calendar". The previous loader silently dropped $1,632 of
// package transactions and three redemptions; the outcome was right and nobody chose it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DECLARED_EXCLUSIONS,
  MUST_SURVIVE,
  isTestBooking,
  isTestPackageTemplate,
} from './exclusions'
import { PROVIDER_CORRECTIONS } from './corrections'

const read = <T>(name: string): T[] =>
  JSON.parse(readFileSync(join('scripts/etl/staged/xano', `${name}.json`), 'utf8'))

interface Booking {
  id: string
  client_name: string | null
  status: string
  price: number | string | null
  start_time: number | string | null
}

const usd = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`
const day = (v: unknown) =>
  v == null ? '—' : typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v).slice(0, 10)

function main() {
  const bookings = read<Booking>('bookings')
  const links = read<{ id: string; booking_id: string }>('checkout_links')
  const templates = read<{ id: string; name: string }>('package_templates')
  const packages = read<{ id: string; package_template_id: string }>('client_packages')
  const items = read<{ id: string; client_package_id: string }>('client_package_items')
  const redemptions = read<{ id: string; booking_id: string | null; client_package_id: string | null }>(
    'package_redemptions',
  )
  const packageTx = read<{ id: string; gross_amount: number | string }>('package_transactions')

  const dropBookings = bookings.filter((b) => isTestBooking(b.client_name))
  const keepBookings = bookings.filter((b) => !isTestBooking(b.client_name))
  const droppedIds = new Set(dropBookings.map((b) => b.id))

  // Cascades. A checkout link without its booking is a payment page for an appointment that
  // does not exist; a redemption without one is a session deducted from a package for a
  // treatment nobody had.
  const dropLinks = links.filter((l) => droppedIds.has(l.booking_id))
  const dropTemplates = templates.filter((t) => isTestPackageTemplate(t.name))
  const dropTemplateIds = new Set(dropTemplates.map((t) => t.id))
  const dropPackages = packages.filter((p) => dropTemplateIds.has(p.package_template_id))
  const dropPackageIds = new Set(dropPackages.map((p) => p.id))
  const dropItems = items.filter((i) => dropPackageIds.has(i.client_package_id))
  const dropRedemptions = redemptions.filter(
    (r) =>
      (r.booking_id && droppedIds.has(r.booking_id)) ||
      (r.client_package_id && dropPackageIds.has(r.client_package_id)),
  )

  console.log('MIGRATION MANIFEST')
  console.log('='.repeat(78))

  console.log('\nKEEPING\n')
  console.log(`  ${keepBookings.length} bookings:`)
  for (const b of keepBookings) {
    console.log(
      `    ${String(b.client_name).padEnd(20)} ${day(b.start_time)}  ${String(b.status).padEnd(10)} ${usd(b.price)}`,
    )
  }
  console.log(`\n  ${links.length - dropLinks.length} checkout links`)

  console.log('\nDROPPING\n')
  console.log(`  ${dropBookings.length} bookings:`)
  for (const b of dropBookings) {
    console.log(
      `    ${String(b.client_name).padEnd(20)} ${day(b.start_time)}  ${String(b.status).padEnd(10)} ${usd(b.price)}`,
    )
  }
  console.log(`\n  ${dropLinks.length} checkout links (cascaded from those bookings)`)
  console.log(`  ${dropTemplates.length} package template(s): ${dropTemplates.map((t) => t.name).join(', ')}`)
  console.log(`  ${dropPackages.length} client packages, ${dropItems.length} items, ${dropRedemptions.length} redemptions (cascaded)`)
  console.log(
    `  ${packageTx.length} package transactions totalling ` +
      usd(packageTx.reduce((sum, t) => sum + Number(t.gross_amount ?? 0), 0)) +
      ' — test-mode payment intents',
  )

  console.log('\nWHY\n')
  for (const e of DECLARED_EXCLUSIONS) {
    console.log(`  ${e.what}`)
    console.log(`    ${e.reason}\n`)
  }

  console.log('CORRECTIONS TO PROVIDER DATA\n')
  for (const c of PROVIDER_CORRECTIONS) {
    console.log(`  ${c.email} — ${Object.keys(c.set).join(', ')}`)
    console.log(`    ${c.reason}\n`)
  }

  // Stated separately and last, because it is the thing most easily lost. Five of the six
  // surviving bookings have no payment recorded — that is real revenue with nowhere in v1 to
  // record it, not a reason to drop the appointment.
  console.log('MUST SURVIVE — check these against the KEEPING list above\n')
  for (const line of MUST_SURVIVE) console.log(`  ${line}`)

  const survived = MUST_SURVIVE.filter((line) =>
    keepBookings.some((b) => line.startsWith(String(b.client_name))),
  )
  const missing = MUST_SURVIVE.filter((line) => !survived.includes(line))

  if (missing.length > 0) {
    console.log(`\n  ${missing.length} OF THESE WOULD BE DROPPED:`)
    for (const line of missing) console.log(`    ${line}`)
    process.exitCode = 1
  } else {
    console.log(`\n  All ${survived.length} accounted for.`)
  }

  const unpaid = keepBookings.filter((b) => Number(b.price ?? 0) > 0)
  console.log(
    `\nAFTER MIGRATING: ${unpaid.length} imported bookings carry a price and need their payment ` +
      `method confirmed in\nadmin Tools > Record a payment. v1 had nowhere to record Cherry, ` +
      `cash or in-person card.`,
  )
}

main()
