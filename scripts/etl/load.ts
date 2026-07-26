// Runs the transforms and loads Neon. Insert order is FK-safe.
//
// Run: npx tsx scripts/etl/load.ts [--force]
//
// Refuses to run against a non-empty database unless --force is passed, because this is a
// full load rather than an incremental sync — re-running against existing rows would
// duplicate the ledger. The neon-http driver has no interactive transactions, so a failure
// mid-run leaves a partial load; recover by truncating and re-running rather than patching.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import * as schema from '@/lib/db/schema'

import * as T from './transform'

const STAGED = join(import.meta.dirname, 'staged')

function load<T>(source: 'xano' | 'stripe', name: string): T[] {
  const path = join(STAGED, source, `${name}.json`)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  // Xano pages wrap rows in { items: [...] }; Stripe lists in { data: [...] }.
  return parsed.items ?? parsed.data ?? parsed
}

async function main() {
  const force = process.argv.includes('--force')

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.ledgerEntries)
  if (count > 0 && !force) {
    throw new Error(`ledger_entries already has ${count} rows. Truncate first, or pass --force.`)
  }

  // ---- staged input ----
  const xProviders = load<T.XanoProvider>('xano', 'providers')
  const xServices = load<T.XanoService>('xano', 'services')
  const xProviderServices = load<T.XanoProviderService>('xano', 'provider_services')
  const xBookings = load<T.XanoBooking>('xano', 'bookings')
  const xTransactions = load<T.XanoTransaction>('xano', 'transactions')
  const xRoomTransactions = load<T.XanoRoomTransaction>('xano', 'room_transactions')
  const xClientPackages = load<T.XanoClientPackage>('xano', 'client_packages')
  const xPackageTransactions = load<T.XanoPackageTransaction>('xano', 'package_transactions')
  const xEnrollments = load<T.XanoTrainingEnrollment>('xano', 'training_enrollments')
  const xCheckoutLinks = load<{ booking_id: string; status: string }>('xano', 'checkout_links')
  const xRedemptions = load<{ booking_id: string }>('xano', 'package_redemptions')

  const sPaymentIntents = load<T.StripePaymentIntent>('stripe', 'payment_intents')
  const sRefunds = load<T.StripeRefund>('stripe', 'refunds')
  const sInvoices = load<T.StripeInvoice>('stripe', 'invoices')

  // ---- providers ----
  const providerRows = xProviders.map(T.transformProvider).filter((r) => r !== null)
  const skipped = xProviders.length - providerRows.length
  if (skipped) console.log(`  skipped ${skipped} test_provider row(s) — not migrated by design`)
  await db.insert(schema.providers).values(providerRows)

  const mdRows = xProviders.map(T.transformMedicalDirectorCredentials).filter((r) => r !== null)
  if (mdRows.length) await db.insert(schema.medicalDirectorCredentials).values(mdRows)

  const liveProviders = new Set(providerRows.map((p) => p.id!))

  // ---- catalog ----
  await db.insert(schema.services).values(xServices.map(T.transformService))
  await db
    .insert(schema.providerServices)
    .values(
      xProviderServices
        .filter((ps) => liveProviders.has(ps.provider_id))
        .map(T.transformProviderService),
    )

  // ---- clients (derived) ----
  const { rows: clientRows, byKey } = T.buildClients(xBookings, xClientPackages)
  if (clientRows.length) await db.insert(schema.clients).values(clientRows)

  // ---- bookings ----
  const redemptionBookingIds = new Set(xRedemptions.map((r) => r.booking_id))
  const paidCheckoutBookingIds = new Set(
    xCheckoutLinks.filter((c) => c.status === 'paid').map((c) => c.booking_id),
  )

  const keptBookings = xBookings.filter((b) => liveProviders.has(b.provider_id))
  const bookingRows = keptBookings.map((b) => {
    const key = T.clientKey({ email: b.client_email, phone: b.client_phone, fallback: b.id })
    return T.transformBooking(
      b,
      byKey.get(key) ?? null,
      T.resolvePaymentSource(b, redemptionBookingIds, paidCheckoutBookingIds),
    )
  })
  if (bookingRows.length) await db.insert(schema.bookings).values(bookingRows)

  // ---- the ledger ----
  const psById = new Map(xProviderServices.map((ps) => [ps.id, ps.service_id]))
  const bookingServiceId = new Map(
    keptBookings.map((b) => [b.id, psById.get(b.provider_service_id) ?? '']),
  )
  const bookingClientId = new Map(
    bookingRows.filter((b) => b.clientId).map((b) => [b.id as string, b.clientId as string]),
  )
  const piIndex = new Map(sPaymentIntents.map((pi) => [pi.id, pi]))

  // Payment intents whose refunds a v1 webhook already recorded — do not rebuild these
  // from Stripe or they double-count. Room is the only path that got this right.
  const alreadyRecorded = new Set(
    xRoomTransactions.filter((t) => t.type === 'refund').map((t) => t.stripe_payment_intent_id),
  )

  const ledger = [
    ...T.ledgerFromTransactions(xTransactions, bookingServiceId, bookingClientId),
    ...T.ledgerFromPackageTransactions(xPackageTransactions, new Map()),
    ...T.ledgerFromRoomTransactions(xRoomTransactions),
    ...T.ledgerFromStripeInvoices(sInvoices, new Map()),
    ...T.ledgerFromTrainingEnrollments(xEnrollments, piIndex),
    ...T.ledgerFromStripeRefunds(sRefunds, piIndex, alreadyRecorded),
  ]

  if (ledger.length) await db.insert(schema.ledgerEntries).values(ledger)

  console.log(
    `loaded: ${providerRows.length} providers, ${clientRows.length} clients, ` +
      `${bookingRows.length} bookings, ${ledger.length} ledger entries`,
  )
  console.log('run `npx tsx scripts/etl/verify.ts` to reconcile against Stripe')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
