// Pure transforms: staged Xano/Stripe rows -> v2 insert rows.
// No I/O and no database access here, so this stays unit-testable.
// The rules encoded below are documented in ./README.md — read that first.

import type {
  bookings,
  clients,
  ledgerEntries,
  providers,
  providerServices,
  services,
} from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Xano exports epoch MILLISECONDS. Passing one to `new Date()` as seconds lands in 1970. */
export function ms(value: number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  return new Date(value)
}

export function msRequired(value: number, field: string): Date {
  const d = ms(value)
  if (!d || Number.isNaN(d.getTime())) throw new Error(`bad timestamp for ${field}: ${value}`)
  return d
}

/** Money is numeric(10,2) — Drizzle maps it to string. Never let a float reach the column. */
export function money(n: number | null | undefined): string {
  return (n ?? 0).toFixed(2)
}

/** Stripe amounts are in the smallest currency unit. */
export function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function negate(amount: string): string {
  return (-Number(amount)).toFixed(2)
}

const lower = (s: string | null | undefined) => s?.trim().toLowerCase() || null

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** v1's `role` enum and `is_admin` boolean were independent and gated different endpoints.
 *  v2 collapses to `role`.
 *
 *  The explicit role WINS over `is_admin`. Letting `is_admin` win looks reasonable — it is
 *  what /admin/* actually checked — but it silently promotes: three v1 accounts carry
 *  `is_admin: true`, and two of them have a more specific role (`developer` and, notably,
 *  `medical_director`). Collapsing those to `platform_owner` would hand a medical director
 *  full owner rights including the revenue dashboard. `is_admin` is only consulted when the
 *  role carries no privilege of its own.
 *
 *  `test_provider` has no v2 role — it existed only because Xano Free has no test data
 *  source, so test accounts lived in production. But those accounts moved REAL money (one
 *  made a live $60 room rental), so dropping them orphans genuine ledger rows. They import
 *  as ordinary providers forced to `inactive`, which keeps referential integrity and keeps
 *  the money attributable. Purge them after the v1 CLN cleanup, not during the migration. */
export function mapRole(xanoRole: string, isAdmin: boolean): (typeof providers.$inferInsert)['role'] {
  if (xanoRole === 'platform_owner') return 'platform_owner'
  if (xanoRole === 'developer') return 'developer'
  if (xanoRole === 'medical_director') return 'medical_director'
  // Only now does is_admin matter: a generic account flagged as admin has no other way to
  // express that privilege.
  if (isAdmin) return 'platform_owner'
  return 'provider'
}

export function isTestProvider(p: XanoProvider): boolean {
  return p.role === 'test_provider'
}

export function transformProvider(p: XanoProvider): typeof providers.$inferInsert {
  const role = mapRole(p.role, p.is_admin)

  return {
    id: p.id,
    joinedAt: msRequired(p.joined_at, 'providers.joined_at'),
    email: p.email.trim().toLowerCase(),
    // Xano hashes with SHA-256 + salt + HMAC, keying undocumented. Not portable.
    passwordHash: null,
    requiresPasswordReset: true,
    firstName: p.first_name,
    lastName: p.last_name,
    phone: p.phone,
    credentials: p.credentials,
    licenseNumber: p.license_number,
    licenseState: p.license_state,
    licenseExpiry: p.license_expiry,
    malpracticeInsurance: p.malpractice_insurance,
    role,
    // Test accounts must never be able to log in or take a booking in v2.
    status: isTestProvider(p) ? 'inactive' : p.status,
    stripeAccountId: p.stripe_account_id,
    stripeOnboardingComplete: p.stripe_onboarding_complete,
    stripeBillingCustomerId: p.stripe_billing_customer_id,
    medicalDirectorType: p.medical_director_type,
    medicalDirectorStatus: p.medical_director_status,
    bookingEnabled: p.booking_enabled,
    roomRentalEnabled: p.room_rental_enabled,
    trainingCertDocumentId: p.training_cert_document_id,
    onboardingStep: p.onboarding_step,
    lastLoginAt: ms(p.last_login_at),
    policyAckAt: ms(p.policy_ack_at),
    policyAckVersion: p.policy_ack_version,
    notifyBookingConfirmed: p.notify_booking_confirmed,
    notifyPayoutDeposited: p.notify_payout_deposited,
    notifyAppointmentReminders: p.notify_appointment_reminders,
    notifyNewAvailability: p.notify_new_availability,
    notifyMembershipBilling: p.notify_membership_billing,
  }
}

/** The sparse `md_*` block, only for providers on the "own director" path. */
export function transformMedicalDirectorCredentials(p: XanoProvider) {
  if (p.medical_director_type !== 'own' || !p.md_name) return null
  return {
    providerId: p.id,
    name: p.md_name,
    npi: p.md_npi,
    licenseNumber: p.md_license_number,
    licenseState: p.md_license_state,
    licenseExpiry: p.md_license_expiry,
    credentials: p.md_credentials,
    contactEmail: lower(p.md_contact_email),
    contactPhone: p.md_contact_phone,
    agreementDocumentId: p.md_agreement_document_id,
  }
}

// ---------------------------------------------------------------------------
// Clients — new in v2, derived
// ---------------------------------------------------------------------------

export type ClientKey = string

/** v1 has no client entity. Identity is derived, in priority order:
 *    email (lowercased) -> phone -> synthetic per-row key.
 *  The synthetic fallback matters: several bookings carry a name and phone but no email,
 *  and collapsing those onto one another would merge unrelated people. */
export function clientKey(input: { email?: string | null; phone?: string | null; fallback: string }): ClientKey {
  const e = lower(input.email)
  if (e) return `email:${e}`
  const p = input.phone?.replace(/[^\d+]/g, '')
  if (p) return `phone:${p}`
  return `row:${input.fallback}`
}

/** Builds the deduped client set from every source that names one. */
export function buildClients(
  xanoBookings: XanoBooking[],
  xanoClientPackages: XanoClientPackage[],
): { rows: (typeof clients.$inferInsert)[]; byKey: Map<ClientKey, string> } {
  const byKey = new Map<ClientKey, string>()
  const rows: (typeof clients.$inferInsert)[] = []

  const upsert = (
    key: ClientKey,
    data: { email?: string | null; name?: string | null; phone?: string | null; createdAt: Date },
  ) => {
    const existing = byKey.get(key)
    if (existing) {
      // Backfill fields a later row knows and an earlier one didn't.
      const row = rows.find((r) => r.id === existing)!
      row.email ??= lower(data.email)
      row.name ??= data.name ?? null
      row.phone ??= data.phone ?? null
      return existing
    }
    const id = crypto.randomUUID()
    byKey.set(key, id)
    rows.push({
      id,
      createdAt: data.createdAt,
      email: lower(data.email),
      name: data.name ?? null,
      phone: data.phone ?? null,
      stripeCustomerId: null,
    })
    return id
  }

  for (const b of xanoBookings) {
    upsert(clientKey({ email: b.client_email, phone: b.client_phone, fallback: b.id }), {
      email: b.client_email,
      name: b.client_name,
      phone: b.client_phone,
      createdAt: msRequired(b.created_at, 'bookings.created_at'),
    })
  }

  for (const cp of xanoClientPackages) {
    upsert(clientKey({ email: cp.client_email, fallback: cp.id }), {
      email: cp.client_email,
      name: cp.client_name,
      createdAt: msRequired(cp.created_at, 'client_packages.created_at'),
    })
  }

  return { rows, byKey }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function transformService(s: XanoService): typeof services.$inferInsert {
  return {
    id: s.id,
    createdAt: msRequired(s.created_at, 'services.created_at'),
    name: s.name,
    description: s.description,
    suggestedDurationMins: s.suggested_duration_mins,
    minDurationMins: s.min_duration_mins,
    maxDurationMins: s.max_duration_mins,
    packageEligible: s.package_eligible,
    advancedTierRequired: s.advanced_tier_required,
    colorHex: s.color_hex,
    active: s.active,
  }
}

export function transformProviderService(ps: XanoProviderService): typeof providerServices.$inferInsert {
  return {
    id: ps.id,
    createdAt: msRequired(ps.created_at, 'provider_services.created_at'),
    providerId: ps.provider_id,
    serviceId: ps.service_id,
    price: money(ps.price),
    durationMins: ps.duration_mins,
    isActive: ps.is_active,
  }
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

/** v1 recorded no payment method — package redemptions came back as ordinary $0 bookings,
 *  so three separate surfaces inferred it from price. Now explicit.
 *
 *  Resolution order matters: a redemption row is authoritative; a paid checkout link is
 *  next; anything else at $0 is comped (this catches the legacy manual bookings, which
 *  predate the current package tables and have no redemption to point at). */
export function resolvePaymentSource(
  b: XanoBooking,
  redemptionBookingIds: Set<string>,
  paidCheckoutBookingIds: Set<string>,
): (typeof bookings.$inferInsert)['paymentSource'] {
  if (redemptionBookingIds.has(b.id)) return 'package_redemption'
  if (paidCheckoutBookingIds.has(b.id)) return 'checkout_link'
  if (Number(b.price) === 0) return 'comped'
  return 'checkout_link'
}

export function transformBooking(
  b: XanoBooking,
  clientId: string | null,
  paymentSource: (typeof bookings.$inferInsert)['paymentSource'],
): typeof bookings.$inferInsert {
  return {
    id: b.id,
    createdAt: msRequired(b.created_at, 'bookings.created_at'),
    providerId: b.provider_id,
    providerServiceId: b.provider_service_id,
    clientId,
    clientName: b.client_name,
    clientPhone: b.client_phone,
    clientEmail: lower(b.client_email),
    treatmentArea: b.treatment_area,
    notes: b.notes,
    originalPrice: money(b.original_price ?? b.price),
    // v1 only ever offered a percentage; a flat-amount discount has no v1 equivalent, so
    // every imported row is either 'percent' or 'none'.
    discountType: (b.discount_pct ?? 0) > 0 ? ('percent' as const) : ('none' as const),
    discountValue: (b.discount_pct ?? 0).toFixed(2),
    price: money(b.price),
    paymentSource,
    durationMins: b.duration_mins,
    startTime: msRequired(b.start_time, 'bookings.start_time'),
    endTime: msRequired(b.end_time, 'bookings.end_time'),
    status: b.status,
    googleCalendarEventId: b.google_calendar_event_id,
    policyAckAt: ms(b.policy_ack_at),
    policyAckVersion: b.policy_ack_version,
  }
}

// ---------------------------------------------------------------------------
// The ledger — the point of the whole migration
// ---------------------------------------------------------------------------

type LedgerRow = typeof ledgerEntries.$inferInsert

/** v1 `transactions` -> booking purchases. gross already EXCLUDES tip here, which is the
 *  v2 convention, so it carries across unchanged. */
export function ledgerFromTransactions(
  txns: XanoTransaction[],
  bookingServiceId: Map<string, string>,
  bookingClientId: Map<string, string>,
): LedgerRow[] {
  return txns.map((t) => ({
    createdAt: msRequired(t.created_at, 'transactions.created_at'),
    source: 'booking',
    payer: 'client',
    entryType: 'purchase',
    subjectType: 'booking',
    subjectId: t.booking_id,
    providerId: t.provider_id,
    clientId: bookingClientId.get(t.booking_id) ?? null,
    serviceId: bookingServiceId.get(t.booking_id) ?? null,
    grossAmount: money(t.gross_amount),
    tipAmount: money(t.tip_amount),
    providerPayout: money(t.provider_payout),
    melaniteCut: money(t.melanite_cut),
    stripePaymentIntentId: t.stripe_payment_intent_id,
    stripeTransferId: t.stripe_transfer_id,
    payoutStatus: t.payout_status,
    payoutDate: t.payout_date,
  }))
}

/** v1 `package_transactions` -> package purchases.
 *  TIP FIX: this ledger's gross INCLUDES the tip, unlike `transactions`. Subtract it so
 *  both obey the v2 convention. Getting this wrong double-counts every tipped package sale. */
export function ledgerFromPackageTransactions(
  txns: XanoPackageTransaction[],
  clientPackageIdByTxn: Map<string, string>,
): LedgerRow[] {
  return txns.map((t) => {
    const grossExclTip = Number(t.gross_amount) - Number(t.tip_amount)
    const isRefund = t.type === 'refund'
    return {
      createdAt: msRequired(t.created_at, 'package_transactions.created_at'),
      source: 'package',
      payer: 'client',
      entryType: isRefund ? 'refund' : 'purchase',
      subjectType: 'client_package',
      // Same reasoning as memberships: pointing a package entry at a Xano transaction id
      // rather than a client package produces a reference that joins to nothing.
      //
      // This throws if the map is empty. `client_packages` had no rows to import, so the path
      // is currently unexercised — but if package transactions ever appear, the caller must
      // supply the mapping rather than have the import quietly write wrong pointers, which is
      // exactly what the membership entries did for four runs.
      subjectId: requirePackageId(clientPackageIdByTxn, t.id),
      providerId: t.provider_id,
      clientId: null,
      serviceId: null,
      grossAmount: isRefund ? negate(money(grossExclTip)) : money(grossExclTip),
      tipAmount: isRefund ? negate(money(t.tip_amount)) : money(t.tip_amount),
      providerPayout: isRefund ? negate(money(t.provider_payout)) : money(t.provider_payout),
      melaniteCut: isRefund ? negate(money(t.melanite_cut)) : money(t.melanite_cut),
      stripePaymentIntentId: t.stripe_payment_intent_id,
      stripeRefundId: t.stripe_refund_id,
      payoutStatus: t.payout_status,
      payoutDate: t.payout_date,
      note: t.note,
    }
  })
}

/** v1 `room_transactions` -> provider-paid, unsplit. The provider pays Melanite, so the
 *  whole amount is platform revenue and there is no payout. Enforced by the schema's
 *  `ledger_entries_provider_paid_is_unsplit` check. */
export function ledgerFromRoomTransactions(txns: XanoRoomTransaction[]): LedgerRow[] {
  return txns.map((t) => {
    const isRefund = t.type === 'refund'
    const gross = isRefund ? negate(money(t.amount)) : money(t.amount)
    return {
      createdAt: msRequired(t.created_at, 'room_transactions.created_at'),
      source: 'room_rental',
      payer: 'provider',
      entryType: isRefund ? 'refund' : 'purchase',
      subjectType: 'room_booking',
      subjectId: t.room_booking_id ?? t.id,
      providerId: t.provider_id,
      grossAmount: gross,
      tipAmount: '0.00',
      providerPayout: '0.00',
      melaniteCut: gross,
      stripePaymentIntentId: t.stripe_payment_intent_id,
      stripeRefundId: t.stripe_refund_id,
      payoutStatus: 'paid',
      note: t.note,
    }
  })
}

function requireMembershipId(map: Map<string, string>, providerId: string): string {
  const id = map.get(providerId)
  if (!id) {
    throw new Error(
      `No membership for provider ${providerId}. A membership ledger entry must point at a ` +
        `membership row; pointing it at the provider produces a reference that joins to nothing.`,
    )
  }
  return id
}

function requirePackageId(map: Map<string, string>, transactionId: string): string {
  const id = map.get(transactionId)
  if (!id) {
    throw new Error(
      `No client package for transaction ${transactionId}. Pointing the ledger entry at the ` +
        `transaction id instead would resolve to nothing.`,
    )
  }
  return id
}

/** Membership revenue exists ONLY in Stripe — no Xano table holds it.
 *  Built from paid invoices, joined to providers by `metadata.provider_id`. */
export function ledgerFromStripeInvoices(
  invoices: StripeInvoice[],
  membershipIdByProvider: Map<string, string>,
): LedgerRow[] {
  return invoices
    .filter((inv) => inv.status === 'paid' && inv.amount_paid > 0)
    .map((inv) => {
      const providerId =
        inv.parent?.subscription_details?.metadata?.provider_id ??
        inv.lines.data[0]?.metadata?.provider_id ??
        null
      if (!providerId) throw new Error(`invoice ${inv.id} has no provider_id in metadata`)

      const gross = centsToMoney(inv.amount_paid)
      return {
        createdAt: new Date((inv.status_transitions.paid_at ?? inv.created) * 1000),
        source: 'membership',
        payer: 'provider',
        entryType: 'purchase',
        subjectType: 'membership',
        // No fallback to `providerId`. A `subject_type = 'membership'` row pointing at a
        // provider is a polymorphic reference that resolves to the wrong table — it looks
        // populated, joins to nothing, and survived four ETL runs unnoticed until an invariant
        // test went looking. If the mapping is missing, that is a bug in the caller and should
        // stop the import rather than be papered over.
        subjectId: requireMembershipId(membershipIdByProvider, providerId),
        providerId,
        grossAmount: gross,
        tipAmount: '0.00',
        providerPayout: '0.00',
        melaniteCut: gross,
        stripeInvoiceId: inv.id,
        payoutStatus: 'paid',
      }
    })
}

/** Training revenue was denormalized onto the enrollment row with no ledger entry.
 *  Rebuilt from the two Stripe payment intents the enrollment references. */
export function ledgerFromTrainingEnrollments(
  enrollments: XanoTrainingEnrollment[],
  paymentIntents: Map<string, StripePaymentIntent>,
): LedgerRow[] {
  const rows: LedgerRow[] = []

  for (const e of enrollments) {
    const legs: Array<[string | null, boolean]> = [
      [e.stripe_deposit_payment_intent_id, e.deposit_paid],
      [e.stripe_balance_payment_intent_id, e.balance_paid],
    ]

    for (const [piId, paid] of legs) {
      if (!piId || !paid) continue
      const pi = paymentIntents.get(piId)
      if (!pi) throw new Error(`enrollment ${e.id} references unknown payment intent ${piId}`)

      const gross = centsToMoney(pi.amount_received)
      rows.push({
        createdAt: new Date(pi.created * 1000),
        source: 'training',
        // The student is usually not a provider yet — training is how they become one.
        payer: 'student',
        entryType: 'purchase',
        subjectType: 'training_enrollment',
        subjectId: e.id,
        providerId: e.provider_id,
        grossAmount: gross,
        tipAmount: '0.00',
        providerPayout: '0.00',
        melaniteCut: gross,
        stripePaymentIntentId: piId,
        payoutStatus: 'paid',
      })
    }
  }

  return rows
}

/** Booking purchases that Stripe has but v1's `transactions` does not.
 *
 *  `transactions` is not a complete record of booking payments — at least one live payment
 *  (`pi_3TqmnZ…`, $17.25) succeeded in Stripe and never produced a ledger row, so v1's
 *  revenue is understated as well as missing refunds. Stripe is authoritative; this fills
 *  the gaps rather than trusting Xano to be complete.
 *
 *  The split is recoverable without Xano: `application_fee_amount` IS the platform's cut on
 *  a destination charge, so payout is the remainder. Tip comes from the checkout link, which
 *  is the only place v1 recorded it. */
export function ledgerFromStripeBookingGaps(
  paymentIntents: StripePaymentIntent[],
  coveredPaymentIntentIds: Set<string>,
  tipByCheckoutLinkId: Map<string, number>,
  bookingClientId: Map<string, string>,
  bookingServiceId: Map<string, string>,
  bookingProviderId: Map<string, string>,
  providerByStripeAccount: Map<string, string>,
): LedgerRow[] {
  const rows: LedgerRow[] = []

  for (const pi of paymentIntents) {
    if (pi.metadata?.type !== 'booking_payment') continue
    if (pi.status !== 'succeeded') continue
    if (coveredPaymentIntentIds.has(pi.id)) continue

    const bookingId = pi.metadata.booking_id
    const checkoutLinkId = pi.metadata.checkout_link_id
    if (!bookingId) throw new Error(`payment intent ${pi.id} has no booking_id in metadata`)

    const tip = tipByCheckoutLinkId.get(checkoutLinkId ?? '') ?? 0
    const total = pi.amount_received / 100
    const cut = (pi.application_fee_amount ?? 0) / 100

    // Resolve the provider from the BOOKING, not from the Connect account id.
    //
    // transfer_data.destination is a Stripe account that may not match any imported
    // provider's stripe_account_id — a provider can reconnect Stripe, or the account can
    // predate the record. The payment intent carries booking_id in its metadata and the
    // booking always knows its provider, so that is the reliable key. The Connect account is
    // kept only as a fallback.
    const providerId =
      bookingProviderId.get(bookingId) ??
      (pi.transfer_data?.destination
        ? (providerByStripeAccount.get(pi.transfer_data.destination) ?? null)
        : null)

    // A null provider here is not a bug to crash on: at least one live payment refers to a
    // booking that has since been DELETED from Xano, which enforces no referential integrity.
    // The money is real, so it belongs in the ledger — dropping it would understate platform
    // revenue. It simply cannot be attributed to anyone, and the caller reports that loudly
    // rather than letting it pass as an ordinary row.

    rows.push({
      createdAt: new Date(pi.created * 1000),
      source: 'booking',
      payer: 'client',
      entryType: 'purchase',
      subjectType: 'booking',
      subjectId: bookingId,
      providerId,
      clientId: bookingClientId.get(bookingId) ?? null,
      serviceId: bookingServiceId.get(bookingId) ?? null,
      grossAmount: money(total - tip),
      tipAmount: money(tip),
      providerPayout: money(total - cut),
      melaniteCut: money(cut),
      stripePaymentIntentId: pi.id,
      payoutStatus: 'paid',
      note: 'Reconstructed from Stripe — v1 recorded no transaction for this payment.',
    })
  }

  return rows
}

/** Refund entries reconstructed from Stripe. v1's `transactions` contains none and never
 *  will — the platform webhook's charge.refunded branch only handles training.
 *
 *  Verified against live data: `transfer_reversal` is null, so the provider KEEPS their
 *  share and the platform absorbs the entire refund. Hence providerPayout 0 and
 *  melaniteCut = the full negative amount. This intentionally breaks the
 *  `cut + payout == gross + tip` identity that holds for purchases. */
export function ledgerFromStripeRefunds(
  refunds: StripeRefund[],
  piIndex: Map<string, StripePaymentIntent>,
  alreadyRecorded: Set<string>,
  bookingProviderId: Map<string, string> = new Map(),
  bookingServiceId: Map<string, string> = new Map(),
  bookingClientId: Map<string, string> = new Map(),
): LedgerRow[] {
  const rows: LedgerRow[] = []

  for (const r of refunds) {
    if (r.status !== 'succeeded') continue
    if (alreadyRecorded.has(r.payment_intent)) continue // e.g. room, handled by its own webhook

    const pi = piIndex.get(r.payment_intent)
    if (!pi) throw new Error(`refund ${r.id} references unknown payment intent ${r.payment_intent}`)

    const type = pi.metadata?.type
    const amount = centsToMoney(r.amount)

    const mapping: Record<string, { source: LedgerRow['source']; subjectType: LedgerRow['subjectType']; payer: LedgerRow['payer'] }> = {
      booking_payment: { source: 'booking', subjectType: 'booking', payer: 'client' },
      room_rental: { source: 'room_rental', subjectType: 'room_booking', payer: 'provider' },
      package_purchase: { source: 'package', subjectType: 'client_package', payer: 'client' },
      training_deposit: { source: 'training', subjectType: 'training_enrollment', payer: 'student' },
      training_balance: { source: 'training', subjectType: 'training_enrollment', payer: 'student' },
    }

    const m = type ? mapping[type] : undefined
    if (!m) throw new Error(`refund ${r.id}: unmapped payment intent type "${type}"`)

    if (r.transfer_reversal) {
      throw new Error(
        `refund ${r.id} HAS a transfer_reversal — the unsplit assumption does not hold. ` +
          `Split it proportionally instead; see scripts/etl/README.md rule 3.`,
      )
    }

    const subjectId =
      pi.metadata?.booking_id ?? pi.metadata?.training_enrollment_id ?? r.payment_intent

    // booking_payment metadata carries booking_id but NOT provider_id — only room_rental
    // does. Reading provider_id off every intent leaves booking refunds unattributed, so the
    // booking is the source of truth wherever there is one.
    const refundProviderId =
      bookingProviderId.get(subjectId) ?? pi.metadata?.provider_id ?? null

    rows.push({
      createdAt: new Date(r.created * 1000),
      source: m.source,
      payer: m.payer,
      entryType: 'refund',
      subjectType: m.subjectType,
      subjectId,
      providerId: refundProviderId,
      clientId: bookingClientId.get(subjectId) ?? null,
      serviceId: bookingServiceId.get(subjectId) ?? null,
      grossAmount: negate(amount),
      tipAmount: '0.00',
      providerPayout: '0.00',
      melaniteCut: negate(amount),
      stripePaymentIntentId: r.payment_intent,
      stripeRefundId: r.id,
      payoutStatus: 'paid',
      note: 'Reconstructed from Stripe — v1 recorded no booking refunds.',
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Staged input shapes (loose — these mirror Xano/Stripe JSON, not the v2 schema)
// ---------------------------------------------------------------------------

export interface XanoProvider {
  id: string; joined_at: number; email: string; first_name: string; last_name: string
  phone: string | null; credentials: string | null; license_number: string | null
  license_state: string | null; license_expiry: string | null; malpractice_insurance: string | null
  stripe_account_id: string | null; stripe_onboarding_complete: boolean; status: 'pending' | 'active' | 'inactive'
  onboarding_step: number; last_login_at: number | null; is_admin: boolean
  medical_director_type: 'melanite' | 'own' | null
  medical_director_status: 'none' | 'active' | 'past_due' | 'inactive'
  stripe_subscription_id: string | null; stripe_billing_customer_id: string | null
  md_name: string | null; md_npi: string | null; md_license_number: string | null
  md_license_state: string | null; md_license_expiry: string | null; md_credentials: string | null
  md_contact_email: string | null; md_contact_phone: string | null
  training_cert_document_id: string | null; md_agreement_document_id: string | null
  notify_booking_confirmed: boolean; notify_payout_deposited: boolean
  notify_appointment_reminders: boolean; notify_new_availability: boolean
  notify_membership_billing: boolean; booking_enabled: boolean; room_rental_enabled: boolean
  policy_ack_at: number | null; policy_ack_version: string | null; role: string
}

export interface XanoBooking {
  id: string; created_at: number; provider_id: string; provider_service_id: string
  client_name: string; client_phone: string | null; client_email: string | null
  treatment_area: string | null; price: number; duration_mins: number
  start_time: number; end_time: number
  status: 'upcoming' | 'completed' | 'cancelled' | 'no_show'
  google_calendar_event_id: string | null; notes: string | null
  original_price: number | null; discount_pct: number | null
  policy_ack_at: number | null; policy_ack_version: string | null
}

export interface XanoService {
  id: string; created_at: number; name: string; description: string | null
  suggested_duration_mins: number; min_duration_mins: number; max_duration_mins: number
  package_eligible: boolean; active: boolean; advanced_tier_required: boolean; color_hex: string | null
}

export interface XanoProviderService {
  id: string; created_at: number; provider_id: string; service_id: string
  price: number; duration_mins: number; is_active: boolean
}

export interface XanoTransaction {
  id: string; created_at: number; provider_id: string; booking_id: string
  checkout_link_id: string | null; source: string; gross_amount: number; tip_amount: number
  provider_payout: number; melanite_cut: number; stripe_payment_intent_id: string
  stripe_transfer_id: string | null; payout_status: 'pending' | 'paid' | 'failed'
  payout_date: string | null
}

export interface XanoPackageTransaction {
  id: string; created_at: number; provider_id: string; package_checkout_link_id: string
  package_template_id: string; type: 'purchase' | 'refund'; gross_amount: number
  tip_amount: number; provider_payout: number; melanite_cut: number
  stripe_payment_intent_id: string; stripe_refund_id: string | null
  payout_status: 'pending' | 'paid' | 'failed'; payout_date: string | null; note: string | null
}

export interface XanoRoomTransaction {
  id: string; created_at: number; room_booking_id: string | null; provider_id: string
  amount: number; type: 'rental' | 'refund'; stripe_payment_intent_id: string
  stripe_refund_id: string | null; note: string | null
}

export interface XanoClientPackage {
  id: string; created_at: number; provider_id: string; client_email: string
  client_name: string | null; package_template_id: string
  purchase_transaction_id: string | null; status: string
  purchased_at: number | null; expires_at: number | null
}

export interface XanoTrainingEnrollment {
  id: string; created_at: number; training_course_id: string; provider_id: string | null
  invite_link_id: string | null; first_name: string; last_name: string; email: string
  phone: string | null; license_number: string | null
  deposit_paid: boolean; deposit_amount: number; stripe_deposit_payment_intent_id: string | null
  balance_paid: boolean; stripe_balance_payment_intent_id: string | null
  course_completed_at: number | null; amount_paid: number; balance_due: number
  payment_status: 'unpaid' | 'partial' | 'paid_in_full'; balance_due_date: string | null
}

export interface StripePaymentIntent {
  id: string; amount: number; amount_received: number; created: number; status: string
  metadata: Record<string, string> | null
  transfer_data: { destination: string } | null
  application_fee_amount: number | null
}

export interface StripeRefund {
  id: string; amount: number; created: number; status: string; payment_intent: string
  transfer_reversal: string | null
}

export interface StripeInvoice {
  id: string; status: string; amount_paid: number; created: number
  status_transitions: { paid_at: number | null }
  parent: { subscription_details?: { subscription: string; metadata?: Record<string, string> } } | null
  lines: { data: Array<{ metadata?: Record<string, string> }> }
}

// ---------------------------------------------------------------------------
// Domain tables beyond the ledger
// ---------------------------------------------------------------------------
//
// These were missing from the first load, which only carried what the revenue view needed.
// `package_redemptions` in particular is load-bearing well beyond reporting: the appointments
// page uses it to decide whether cancelling gives a prepaid session back or destroys it.

export function transformCheckoutLink(c: XanoCheckoutLink) {
  return {
    id: c.id,
    createdAt: msRequired(c.created_at, 'checkout_links.created_at'),
    bookingId: c.booking_id,
    token: c.token,
    status: c.status,
    tipAmount: money(c.tip_amount),
    stripeCustomerId: c.stripe_customer_id,
    stripePaymentIntentId: c.stripe_payment_intent_id,
    paidAt: ms(c.paid_at),
    expiresAt: msRequired(c.expires_at, 'checkout_links.expires_at'),
  }
}

export function transformPackageTemplate(t: XanoPackageTemplate) {
  return {
    id: t.id,
    createdAt: msRequired(t.created_at, 'package_templates.created_at'),
    providerId: t.provider_id,
    name: t.name,
    description: t.description,
    totalPrice: money(t.total_price),
    expiresAfterDays: t.expires_after_days,
    active: t.active,
  }
}

export function transformPackageTemplateItem(i: XanoPackageTemplateItem) {
  return {
    id: i.id,
    packageTemplateId: i.package_template_id,
    serviceId: i.service_id,
    quantity: i.quantity,
    perSessionValue: money(i.per_session_value),
  }
}

export function transformClientPackage(p: XanoClientPackage, clientId: string) {
  return {
    id: p.id,
    createdAt: msRequired(p.created_at, 'client_packages.created_at'),
    providerId: p.provider_id,
    clientId,
    packageTemplateId: p.package_template_id,
    status: p.status as 'active' | 'exhausted' | 'expired' | 'refunded',
    purchasedAt: ms(p.purchased_at),
    expiresAt: ms(p.expires_at),
  }
}

export function transformClientPackageItem(i: XanoClientPackageItem) {
  return {
    id: i.id,
    clientPackageId: i.client_package_id,
    serviceId: i.service_id,
    perSessionValue: money(i.per_session_value),
    qtyTotal: i.qty_total,
    qtyUsed: i.qty_used ?? 0,
  }
}

export function transformPackageRedemption(r: XanoPackageRedemption) {
  return {
    id: r.id,
    createdAt: msRequired(r.created_at, 'package_redemptions.created_at'),
    clientPackageId: r.client_package_id,
    clientPackageItemId: r.client_package_item_id,
    bookingId: r.booking_id,
    overallIndex: r.overall_index,
    serviceIndex: r.service_index,
    redeemedAt: ms(r.redeemed_at) ?? msRequired(r.created_at, 'package_redemptions.created_at'),
    // Null means the redemption stands; set means the booking was cancelled and the session
    // was returned. Excluded from balance maths but kept for audit.
    voidedAt: ms(r.voided_at),
  }
}

export function transformRoomBooking(r: XanoRoomBooking) {
  return {
    id: r.id,
    createdAt: msRequired(r.created_at, 'room_bookings.created_at'),
    providerId: r.provider_id,
    rentalDate: r.rental_date,
    slotType: r.slot_type,
    price: money(r.price),
    status: r.status,
    startAt: msRequired(r.start_at, 'room_bookings.start_at'),
    endAt: msRequired(r.end_at, 'room_bookings.end_at'),
    cancelledAt: ms(r.cancelled_at),
  }
}

export function transformMembership(m: XanoMembership) {
  return {
    id: m.id,
    createdAt: msRequired(m.created_at, 'memberships.created_at'),
    providerId: m.provider_id,
    plan: 'medical_director' as const,
    status: m.status,
    stripeSubscriptionId: m.stripe_subscription_id,
    stripeCustomerId: m.stripe_customer_id,
    cancelAtPeriodEnd: m.cancel_at_period_end ?? false,
    startDate: ms(m.start_date),
    renewalDate: ms(m.renewal_date),
    cancelDate: ms(m.cancel_date),
  }
}

export function transformTrainingCourse(c: XanoTrainingCourse) {
  return {
    id: c.id,
    createdAt: msRequired(c.created_at, 'training_courses.created_at'),
    day1Date: c.day1_date,
    day1Start: c.day1_start,
    day1End: c.day1_end,
    day2Date: c.day2_date,
    day2Start: c.day2_start,
    day2End: c.day2_end,
    maxStudents: c.max_students,
    depositAmount: money(c.deposit_amount),
    totalPrice: money(c.total_price),
    googleCalendarEventIdDay1: c.google_calendar_event_id_day1,
    googleCalendarEventIdDay2: c.google_calendar_event_id_day2,
    status: c.status,
  }
}

export function transformTrainingEnrollment(e: XanoTrainingEnrollment) {
  return {
    id: e.id,
    createdAt: msRequired(e.created_at, 'training_enrollments.created_at'),
    trainingCourseId: e.training_course_id,
    providerId: e.provider_id,
    inviteLinkId: null, // invite_links is not migrated; the FK would dangle.
    firstName: e.first_name,
    lastName: e.last_name,
    email: e.email.trim().toLowerCase(),
    phone: e.phone,
    licenseNumber: e.license_number,
    paymentStatus: e.payment_status,
    balanceDueDate: e.balance_due_date,
    courseCompletedAt: ms(e.course_completed_at),
  }
}

export interface XanoCheckoutLink {
  id: string; created_at: number; booking_id: string; token: string
  status: 'pending' | 'paid' | 'expired' | 'cancelled'; tip_amount: number
  stripe_customer_id: string | null; stripe_payment_intent_id: string | null
  paid_at: number | null; expires_at: number
}
export interface XanoPackageTemplate {
  id: string; created_at: number; provider_id: string; name: string
  description: string | null; total_price: number; expires_after_days: number | null
  active: boolean
}
export interface XanoPackageTemplateItem {
  id: string; package_template_id: string; service_id: string
  quantity: number; per_session_value: number
}
export interface XanoClientPackageItem {
  id: string; client_package_id: string; service_id: string
  per_session_value: number; qty_total: number; qty_used: number | null
}
export interface XanoPackageRedemption {
  id: string; created_at: number; client_package_id: string; client_package_item_id: string
  booking_id: string; overall_index: number; service_index: number
  redeemed_at: number | null; voided_at: number | null
}
export interface XanoRoomBooking {
  id: string; created_at: number; provider_id: string; rental_date: string
  slot_type: 'full' | 'am' | 'pm'; price: number
  status: 'confirmed' | 'cancellation_requested' | 'cancelled' | 'refunded'
  start_at: number; end_at: number; cancelled_at: number | null
}
export interface XanoMembership {
  id: string; created_at: number; provider_id: string
  status: 'active' | 'past_due' | 'cancelled'
  stripe_subscription_id: string | null; stripe_customer_id: string | null
  cancel_at_period_end: boolean | null
  start_date: number | null; renewal_date: number | null; cancel_date: number | null
}
export interface XanoTrainingCourse {
  id: string; created_at: number; day1_date: string; day1_start: string; day1_end: string
  day2_date: string | null; day2_start: string; day2_end: string; max_students: number
  deposit_amount: number; total_price: number
  google_calendar_event_id_day1: string | null; google_calendar_event_id_day2: string | null
  status: 'scheduled' | 'completed' | 'cancelled'
}

/** The singleton config row — laser hours, the provider share, feature flags, and the
 *  medical-director price id.
 *
 *  Was missing from the first load, which meant the app silently fell back to hardcoded
 *  defaults. Those happened to match production (08:00–20:00, 15-minute stride), so nothing
 *  looked wrong — the medical-director price id was simply absent, which disables the
 *  subscribe button with no visible reason. Defaults that coincidentally agree with reality
 *  are worse than ones that do not, because nothing surfaces the gap. */
export function transformPlatformSettings(s: XanoPlatformSettings) {
  return {
    id: 1,
    providerSharePct: (s.provider_share_pct ?? 0.5).toFixed(3),
    tipToProviderPct: (s.tip_to_provider_pct ?? 1).toFixed(3),
    noShowFeePctOfPrice: (s.noshow_fee_pct_of_price ?? 0.5).toFixed(3),
    cancellationFeeAmount: money(s.cancellation_fee_amount),
    stripePlatformAccountId: s.stripe_platform_account_id,
    medicalDirectorPriceId: s.medical_director_price_id,
    laserOpenTime: s.laser_open_time,
    laserCloseTime: s.laser_close_time,
    slotStrideMins: s.slot_stride_mins,
    roomRentalEnabled: s.room_rental_enabled ?? false,
    packagesEnabled: s.packages_enabled ?? false,
    updatedAt: ms(s.updated_at) ?? new Date(),
    updatedBy: null,
  }
}

/** Renewal dates by Stripe subscription id.
 *
 *  Xano's memberships.renewal_date is null on every row — the webhook that would set it never
 *  populated it — but Stripe knows, on the subscription item's current_period_end. Without
 *  this the membership page can say a subscription is active but not when it renews, which is
 *  the one thing a provider actually wants from that screen. */
export function renewalDatesFromStripe(
  subscriptions: StripeSubscription[],
): Map<string, Date> {
  const byId = new Map<string, Date>()
  for (const sub of subscriptions) {
    const end = sub.items?.data?.[0]?.current_period_end
    if (end) byId.set(sub.id, new Date(end * 1000))
  }
  return byId
}

export interface XanoPlatformSettings {
  id: number; provider_share_pct: number; tip_to_provider_pct: number
  noshow_fee_pct_of_price: number; cancellation_fee_amount: number
  stripe_platform_account_id: string; medical_director_price_id: string | null
  laser_open_time: string; laser_close_time: string; slot_stride_mins: number
  room_rental_enabled: boolean | null; packages_enabled: boolean | null
  updated_at: number | null
}

export interface StripeSubscription {
  id: string
  status: string
  items: { data: Array<{ current_period_end: number }> }
}
