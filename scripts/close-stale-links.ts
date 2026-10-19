import '../envConfig'

import { and, eq, lt, sql } from 'drizzle-orm'

import { bookings, checkoutLinks, providers, providerServices, services } from '@/lib/db/schema'

import { describeDatabase, requireEnv, requireProductionOptIn } from '../lib/env-guard'
import { db } from './db'

// Closes the payment links nobody can pay any more.
//
//   npx tsx --tsconfig scripts/tsconfig.json scripts/close-stale-links.ts
//   npx tsx --tsconfig scripts/tsconfig.json scripts/close-stale-links.ts --apply
//   MELANITE_ENV_FILE=.env.migration npx tsx ... --apply --i-know-this-is-production
//
// WHY THIS EXISTS
//
// Melanite stopped taking client money on 14 October. What it left behind is a tail of
// `checkout_links` still sitting at `pending` — appointments where a client was sent a link and
// never paid it. On 19 October there were fifteen, worth $1,510 of client money, and NOT ONE of
// them had a single cent recorded against it. No money ever moved: Melanite never held any, and
// no provider was ever paid any.
//
// Thirteen of the fifteen had already EXPIRED, which is the whole point of this script. An
// expired link is already unpayable — a client clicking it today gets a dead page — so these
// are not money waiting to be collected. They are rows describing an intention that lapsed,
// and they will sit at `pending` for ever unless something says otherwise.
//
// WHAT IT DOES NOT DO, deliberately: it records no payment.
//
// Keoni's account of what actually happened is that the girls mostly settle up over Venmo, so
// most of these were very likely paid outside the app months ago. "Very likely" is not a basis
// for writing $1,325 of revenue into the ledger. A purchase row here would show up on the
// revenue page as income Melanite can prove, and a figure that was assumed is worse than a gap
// that is visible. The booking stays exactly as it is; only the dead link is closed.
//
// If Keoni wants a specific one recorded as collected, Tools -> "Record a payment" does it
// properly, against her own CSV, one appointment at a time, with her name on it.
//
// IT WILL NOT TOUCH A LIVE LINK. A link that has not expired is money a client could still
// pay today, and closing one is the single way this script could cost somebody real money.
// `--include-live` exists for the day the last of them lapses, and names each one first.

const apply = process.argv.includes('--apply')
const includeLive = process.argv.includes('--include-live')

interface StaleLink {
  linkId: string
  token: string
  provider: string
  clientName: string | null
  serviceName: string
  price: string
  apptDate: Date
  expiresAt: Date
  expired: boolean
  recordedPayment: boolean
}

async function main() {
  const env = requireEnv(['dev', 'prod'], 'close stale checkout links')
  if (env === 'prod') requireProductionOptIn('close stale checkout links')

  console.log(`\n${apply ? 'Closing' : 'Dry run against'} ${describeDatabase()}\n`)

  const rows = await db
    .select({
      linkId: checkoutLinks.id,
      token: checkoutLinks.token,
      first: providers.firstName,
      last: providers.lastName,
      clientName: bookings.clientName,
      serviceName: services.name,
      price: bookings.price,
      apptDate: bookings.startTime,
      expiresAt: checkoutLinks.expiresAt,
      expired: lt(checkoutLinks.expiresAt, sql`now()`).mapWith(Boolean),
      // The one fact that decides whether this is safe. A link with money recorded against it
      // is not stale, it is PAID and mis-statused — and closing it would bury that.
      recordedPayment: sql<boolean>`exists (
        select 1 from ledger_entries l
         where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
           and l.entry_type = 'purchase'
      )`,
    })
    .from(checkoutLinks)
    .innerJoin(bookings, eq(checkoutLinks.bookingId, bookings.id))
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(eq(checkoutLinks.status, 'pending'))
    .orderBy(providers.firstName, bookings.startTime)

  const all: StaleLink[] = rows.map((r) => ({
    linkId: r.linkId,
    token: r.token,
    provider: `${r.first} ${r.last}`,
    clientName: r.clientName,
    serviceName: r.serviceName,
    price: r.price,
    apptDate: r.apptDate,
    expiresAt: r.expiresAt,
    expired: r.expired,
    recordedPayment: r.recordedPayment,
  }))

  if (all.length === 0) {
    console.log('  Nothing pending. Every checkout link is settled.\n')
    return
  }

  // Three buckets, because they want three different things done to them.
  const paid = all.filter((l) => l.recordedPayment)
  const live = all.filter((l) => !l.recordedPayment && !l.expired)
  const stale = all.filter((l) => !l.recordedPayment && l.expired)

  const money = (v: string) => `$${Number(v).toFixed(2)}`
  const day = (d: Date) => d.toISOString().slice(0, 10)

  if (paid.length > 0) {
    // Left alone and shouted about. A link still `pending` with a purchase row against it means
    // the payment landed and the status never caught up — a bookkeeping fault, not a dead link,
    // and quietly closing it would hide the only evidence.
    console.log('  PAID BUT STILL PENDING — not touched, these need looking at:\n')
    for (const l of paid) {
      console.log(`    ${l.provider.padEnd(20)} ${money(l.price).padStart(9)}  ${day(l.apptDate)}  ${l.serviceName}`)
    }
    console.log('')
  }

  if (live.length > 0) {
    console.log(`  STILL LIVE — a client could pay ${live.length === 1 ? 'this' : 'these'} today:\n`)
    for (const l of live) {
      console.log(
        `    ${l.provider.padEnd(20)} ${money(l.price).padStart(9)}  appt ${day(l.apptDate)}  ` +
          `link good until ${day(l.expiresAt)}  ${l.serviceName}`,
      )
    }
    console.log(
      includeLive
        ? '\n    --include-live was passed, so these WILL be closed.\n'
        : '\n    Left alone. Re-run with --include-live once they have lapsed or been converted.\n',
    )
  }

  if (stale.length === 0 && !(includeLive && live.length > 0)) {
    console.log('  No expired links to close.\n')
    return
  }

  const targets = includeLive ? [...stale, ...live] : stale

  console.log(`  EXPIRED — unpayable already, ${apply ? 'closing' : 'would close'}:\n`)
  let total = 0
  for (const l of targets) {
    total += Number(l.price)
    console.log(
      `    ${l.provider.padEnd(20)} ${money(l.price).padStart(9)}  appt ${day(l.apptDate)}  ` +
        `expired ${day(l.expiresAt)}  ${l.serviceName}`,
    )
  }

  console.log(`\n  ${targets.length} link(s), ${money(String(total))} of client money never collected here.`)
  console.log('  The appointments are untouched — only the dead links are closed.')

  if (!apply) {
    console.log('\n  Dry run. Re-run with --apply to close them.\n')
    return
  }

  for (const l of targets) {
    await db
      .update(checkoutLinks)
      .set({ status: 'expired' })
      .where(and(eq(checkoutLinks.id, l.linkId), eq(checkoutLinks.status, 'pending')))
  }

  console.log(`\n  Closed ${targets.length} link(s).`)
  console.log('  No payment was recorded for any of them. If one was in fact collected,')
  console.log('  Tools -> "Record a payment" is where that belongs.\n')
}

main().then(() => process.exit(process.exitCode ?? 0))
