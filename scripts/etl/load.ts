// Runs the transforms and loads Neon. Insert order is FK-safe.
//
// Run: npx tsx scripts/etl/load.ts [--force]
//
// Refuses to run against a non-empty database, because this is a full load rather than an
// incremental sync — inserting over existing rows would duplicate the ledger. `--force`
// TRUNCATES and reloads; it does not mean "insert anyway". That matters because the
// neon-http driver has no interactive transactions, so a mid-run failure leaves partial data
// behind and a plain retry would just collide on primary keys.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { db } from '../db'
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
    throw new Error(`ledger_entries already has ${count} rows. Re-run with --force to replace.`)
  }

  // --force means "replace everything", not "insert anyway". This is a full load, and the
  // neon-http driver has no interactive transactions, so a mid-run failure leaves partial
  // data behind — without truncating, the retry just collides on primary keys.
  if (force) {
    console.log('  --force: clearing existing data')
    await db.execute(sql`
      TRUNCATE TABLE
        ledger_entries, package_redemptions, client_package_items, client_packages,
        package_checkout_links, package_template_items, package_templates,
        checkout_links, bookings, room_bookings, memberships,
        training_enrollments, training_courses, clients,
        provider_services, services, medical_director_credentials,
        documents, invite_links, password_reset_tokens, webhook_events,
        platform_settings, providers
      RESTART IDENTITY CASCADE
    `)
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
  const xCheckoutLinks = load<{ id: string; booking_id: string; status: string; tip_amount: number }>(
    'xano',
    'checkout_links',
  )
  const xRedemptions = load<{ booking_id: string }>('xano', 'package_redemptions')

  const sPaymentIntents = load<T.StripePaymentIntent>('stripe', 'payment_intents')
  const sRefunds = load<T.StripeRefund>('stripe', 'refunds')
  const sInvoices = load<T.StripeInvoice>('stripe', 'invoices')

  // ---- providers ----
  const providerRows = xProviders.map(T.transformProvider)
  const testProviders = xProviders.filter(T.isTestProvider)
  if (testProviders.length) {
    console.log(
      `  ${testProviders.length} test_provider account(s) imported as status=inactive — ` +
        'they moved real money, so dropping them would orphan live ledger rows. ' +
        'Purge after the v1 CLN cleanup.',
    )
  }
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

  // Stripe is authoritative for booking money. v1's `transactions` is missing at least one
  // succeeded payment, so anything Stripe has that Xano does not gets rebuilt from Stripe.
  const coveredPaymentIntentIds = new Set(xTransactions.map((t) => t.stripe_payment_intent_id))
  const tipByCheckoutLinkId = new Map(
    xCheckoutLinks.map((c) => [c.id, Number(c.tip_amount ?? 0)]),
  )
  const providerByStripeAccount = new Map(
    xProviders
      .filter((p) => p.stripe_account_id)
      .map((p) => [p.stripe_account_id as string, p.id]),
  )

  const candidate = [
    ...T.ledgerFromTransactions(xTransactions, bookingServiceId, bookingClientId),
    ...T.ledgerFromStripeBookingGaps(
      sPaymentIntents,
      coveredPaymentIntentIds,
      tipByCheckoutLinkId,
      bookingClientId,
      bookingServiceId,
      providerByStripeAccount,
    ),
    ...T.ledgerFromPackageTransactions(xPackageTransactions, new Map()),
    ...T.ledgerFromRoomTransactions(xRoomTransactions),
    ...T.ledgerFromStripeInvoices(sInvoices, new Map()),
    ...T.ledgerFromTrainingEnrollments(xEnrollments, piIndex),
    ...T.ledgerFromStripeRefunds(sRefunds, piIndex, alreadyRecorded),
  ]

  // A money row whose payment intent does not exist in LIVE Stripe is not real money.
  //
  // Xano has no test data source on the Free plan, so test records were written straight
  // into production tables — `package_transactions` in particular carries test-mode rows
  // whose PIs belong to a different Stripe account context. Importing them would invent
  // platform revenue that was never collected.
  //
  // Rows with no payment intent at all (membership entries, built from Stripe invoices) are
  // inherently live, since they came from Stripe rather than Xano.
  const dropped = candidate.filter(
    (r) => r.stripePaymentIntentId && !piIndex.has(r.stripePaymentIntentId),
  )
  const ledger = candidate.filter(
    (r) => !r.stripePaymentIntentId || piIndex.has(r.stripePaymentIntentId),
  )

  if (dropped.length) {
    // Loud, never silent — a dropped row is either test data or a real gap in Stripe, and
    // the two need different responses.
    const total = dropped.reduce((sum, r) => sum + Number(r.melaniteCut ?? 0), 0)
    console.log(
      `\n  DROPPED ${dropped.length} ledger row(s) with no live Stripe payment ` +
        `(${total.toFixed(2)} of platform revenue not imported):`,
    )
    for (const r of dropped) {
      console.log(`    ${r.source} ${r.entryType} cut=${r.melaniteCut} pi=${r.stripePaymentIntentId}`)
    }
    console.log('    Expected for known test records; investigate anything unfamiliar.\n')
  }

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
