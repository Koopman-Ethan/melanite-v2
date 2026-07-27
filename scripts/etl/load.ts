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

import { eq, isNotNull, sql } from 'drizzle-orm'

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

  // Passwords are the one thing worth carrying across a reload.
  //
  // Xano's hashes are not portable, so every provider imports with a null hash and
  // requires_password_reset set. That is correct for a first load — but during development
  // this script gets re-run constantly, and each run silently signs out anyone who had set a
  // password, which reads as "the password stopped working" rather than "the ETL ran".
  // Snapshot them by email and put them back afterwards.
  const carriedPasswords = force
    ? await db
        .select({
          email: schema.providers.email,
          passwordHash: schema.providers.passwordHash,
          requiresPasswordReset: schema.providers.requiresPasswordReset,
        })
        .from(schema.providers)
        .where(isNotNull(schema.providers.passwordHash))
    : []

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
  const xRedemptions = load<T.XanoPackageRedemption>('xano', 'package_redemptions')
  const xPackageTemplates = load<T.XanoPackageTemplate>('xano', 'package_templates')
  const xPackageTemplateItems = load<T.XanoPackageTemplateItem>('xano', 'package_template_items')
  const xClientPackageItems = load<T.XanoClientPackageItem>('xano', 'client_package_items')
  const xRoomBookings = load<T.XanoRoomBooking>('xano', 'room_bookings')
  const xMemberships = load<T.XanoMembership>('xano', 'memberships')
  const xTrainingCourses = load<T.XanoTrainingCourse>('xano', 'training_courses')
  const xPlatformSettings = load<T.XanoPlatformSettings>('xano', 'platform_settings')

  const sPaymentIntents = load<T.StripePaymentIntent>('stripe', 'payment_intents')
  const sRefunds = load<T.StripeRefund>('stripe', 'refunds')
  const sInvoices = load<T.StripeInvoice>('stripe', 'invoices')
  const sSubscriptions = load<T.StripeSubscription>('stripe', 'subscriptions')

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

  for (const carried of carriedPasswords) {
    await db
      .update(schema.providers)
      .set({
        passwordHash: carried.passwordHash,
        requiresPasswordReset: carried.requiresPasswordReset,
      })
      .where(eq(schema.providers.email, carried.email))
  }
  if (carriedPasswords.length) {
    console.log(`  carried ${carriedPasswords.length} existing password(s) across the reload`)
  }

  // ---- platform settings ----
  // Drives laser hours, the provider share and the medical-director price. Without it the app
  // falls back to defaults that happen to match, which hides the gap rather than showing it.
  if (xPlatformSettings[0]) {
    await db.insert(schema.platformSettings).values(T.transformPlatformSettings(xPlatformSettings[0]))
  }

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

  // ---- checkout links ----
  const keptBookingIds = new Set(bookingRows.map((b) => b.id!))
  const checkoutRows = xCheckoutLinks
    .filter((c) => keptBookingIds.has(c.booking_id))
    .map((c) => T.transformCheckoutLink(c as T.XanoCheckoutLink))
  if (checkoutRows.length) await db.insert(schema.checkoutLinks).values(checkoutRows)

  // ---- packages ----
  // Ordered by dependency: templates -> template items -> purchased packages -> their items
  // -> redemptions. package_redemptions is what tells the appointments page whether cancelling
  // returns a prepaid session or destroys it, so leaving it out is not a reporting gap.
  const templateRows = xPackageTemplates
    .filter((t) => liveProviders.has(t.provider_id))
    .map(T.transformPackageTemplate)
  if (templateRows.length) await db.insert(schema.packageTemplates).values(templateRows)

  const keptTemplateIds = new Set(templateRows.map((t) => t.id))
  const templateItemRows = xPackageTemplateItems
    .filter((i) => keptTemplateIds.has(i.package_template_id))
    .map(T.transformPackageTemplateItem)
  if (templateItemRows.length) {
    await db.insert(schema.packageTemplateItems).values(templateItemRows)
  }

  const clientPackageRows = xClientPackages
    .filter((p) => liveProviders.has(p.provider_id) && keptTemplateIds.has(p.package_template_id))
    .map((p) => {
      const key = T.clientKey({ email: p.client_email, fallback: p.id })
      const clientId = byKey.get(key)
      if (!clientId) throw new Error(`client_package ${p.id} has no resolvable client`)
      return T.transformClientPackage(p, clientId)
    })
  if (clientPackageRows.length) await db.insert(schema.clientPackages).values(clientPackageRows)

  const keptPackageIds = new Set(clientPackageRows.map((p) => p.id))
  const packageItemRows = xClientPackageItems
    .filter((i) => keptPackageIds.has(i.client_package_id))
    .map(T.transformClientPackageItem)
  if (packageItemRows.length) await db.insert(schema.clientPackageItems).values(packageItemRows)

  const keptItemIds = new Set(packageItemRows.map((i) => i.id))
  const redemptionRows = xRedemptions
    .filter(
      (r) =>
        keptPackageIds.has(r.client_package_id) &&
        keptItemIds.has(r.client_package_item_id) &&
        keptBookingIds.has(r.booking_id),
    )
    .map(T.transformPackageRedemption)
  if (redemptionRows.length) await db.insert(schema.packageRedemptions).values(redemptionRows)

  // ---- room, membership, training ----
  const roomRows = xRoomBookings
    .filter((r) => liveProviders.has(r.provider_id))
    .map(T.transformRoomBooking)
  if (roomRows.length) await db.insert(schema.roomBookings).values(roomRows)

  // Xano never populated renewal_date; Stripe has it on the subscription item.
  const renewals = T.renewalDatesFromStripe(sSubscriptions)
  const membershipRows = xMemberships
    .filter((m) => liveProviders.has(m.provider_id))
    .map(T.transformMembership)
    .map((m) => ({
      ...m,
      renewalDate:
        m.renewalDate ??
        (m.stripeSubscriptionId ? (renewals.get(m.stripeSubscriptionId) ?? null) : null),
    }))
  if (membershipRows.length) await db.insert(schema.memberships).values(membershipRows)

  const courseRows = xTrainingCourses.map(T.transformTrainingCourse)
  if (courseRows.length) await db.insert(schema.trainingCourses).values(courseRows)

  const keptCourseIds = new Set(courseRows.map((c) => c.id))
  const enrollmentRows = xEnrollments
    .filter((e) => keptCourseIds.has(e.training_course_id))
    .filter((e) => !e.provider_id || liveProviders.has(e.provider_id))
    .map(T.transformTrainingEnrollment)
  if (enrollmentRows.length) {
    await db.insert(schema.trainingEnrollments).values(enrollmentRows)
  }

  // ---- the ledger ----
  const psById = new Map(xProviderServices.map((ps) => [ps.id, ps.service_id]))
  const bookingServiceId = new Map(
    keptBookings.map((b) => [b.id, psById.get(b.provider_service_id) ?? '']),
  )
  const bookingClientId = new Map(
    bookingRows.filter((b) => b.clientId).map((b) => [b.id as string, b.clientId as string]),
  )
  const bookingProviderId = new Map(
    bookingRows.map((b) => [b.id as string, b.providerId as string]),
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
      bookingProviderId,
      providerByStripeAccount,
    ),
    ...T.ledgerFromPackageTransactions(xPackageTransactions, new Map()),
    ...T.ledgerFromRoomTransactions(xRoomTransactions),
    ...T.ledgerFromStripeInvoices(sInvoices, new Map()),
    ...T.ledgerFromTrainingEnrollments(xEnrollments, piIndex),
    ...T.ledgerFromStripeRefunds(
      sRefunds,
      piIndex,
      alreadyRecorded,
      bookingProviderId,
      bookingServiceId,
      bookingClientId,
    ),
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

  // Money that reached Stripe but cannot be tied to a provider — almost always a booking that
  // was deleted from Xano after the payment. Platform revenue still counts it; provider
  // earnings cannot. Reported every run so it stays visible rather than becoming background.
  const unattributed = ledger.filter((r) => !r.providerId && r.source !== 'training')
  if (unattributed.length) {
    const cut = unattributed.reduce((s, r) => s + Number(r.melaniteCut ?? 0), 0)
    const payout = unattributed.reduce((s, r) => s + Number(r.providerPayout ?? 0), 0)
    console.log(
      `\n  UNATTRIBUTED: ${unattributed.length} ledger row(s) with no provider ` +
        `(${cut.toFixed(2)} platform cut, ${payout.toFixed(2)} provider payout):`,
    )
    for (const r of unattributed) {
      console.log(`    ${r.source} ${r.entryType} subject=${r.subjectId} pi=${r.stripePaymentIntentId}`)
    }
    console.log('    Usually a booking deleted from Xano after the payment settled.\n')
  }

  if (ledger.length) await db.insert(schema.ledgerEntries).values(ledger)

  console.log(
    `loaded: ${providerRows.length} providers, ${clientRows.length} clients, ` +
      `${bookingRows.length} bookings, ${checkoutRows.length} checkout links, ` +
      `${clientPackageRows.length} packages (${redemptionRows.length} redemptions), ` +
      `${roomRows.length} room bookings, ${membershipRows.length} memberships, ` +
      `${enrollmentRows.length} enrollments, ${ledger.length} ledger entries`,
  )
  console.log('run `npx tsx scripts/etl/verify.ts` to reconcile against Stripe')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
