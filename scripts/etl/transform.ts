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
    discountPct: (b.discount_pct ?? 0).toFixed(2),
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
      subjectId: clientPackageIdByTxn.get(t.id) ?? t.id,
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
        subjectId: membershipIdByProvider.get(providerId) ?? providerId,
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

    const providerId = pi.transfer_data?.destination
      ? (providerByStripeAccount.get(pi.transfer_data.destination) ?? null)
      : null

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

    rows.push({
      createdAt: new Date(r.created * 1000),
      source: m.source,
      payer: m.payer,
      entryType: 'refund',
      subjectType: m.subjectType,
      subjectId: pi.metadata?.booking_id ?? pi.metadata?.training_enrollment_id ?? r.payment_intent,
      providerId: pi.metadata?.provider_id ?? null,
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
