// Melanite v2 schema.
//
// Models the business, not Xano's tables. See `docs/v1-spec/revenue-model.md` for why the
// ledger looks the way it does, and `docs/v1-spec/schema/*.xs` for the v1 definitions this
// was derived from.
//
// Conventions:
//  - Column names come from property names via `casing: 'snake_case'` (see lib/db/index.ts).
//  - Money is `numeric(10,2)`, which Drizzle maps to `string` — never float. Do arithmetic
//    in SQL or a decimal library, not in JS numbers.
//  - Timestamps are `timestamptz`. The business timezone is America/Denver; store UTC and
//    convert at the edge.
//
// Deliberately NOT ported from v1:
//  - `user` / `event_log` — Xano quick-start scaffolding (tagged `xano:quick-start`),
//    never used by the app. `providers` is the real auth table.
//  - `providers.is_admin` — collapsed into the `role` enum; v1 had both and gated on
//    different ones in different places.
//  - `role = 'test_provider'` — existed because Xano Free has no test data source, so test
//    accounts lived in production. v2 has real environments.
//  - `room_bookings.active_slot_key` — a denormalized string that existed only to fake a
//    partial unique index. Postgres does this natively; see `roomBookings` below.

import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/** Money columns: 10 digits, 2 decimal places, returned as string. */
const money = () => numeric({ precision: 10, scale: 2 })

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const providerRole = pgEnum('provider_role', [
  'platform_owner',
  'developer',
  'medical_director',
  'provider',
])

export const providerStatus = pgEnum('provider_status', ['pending', 'active', 'inactive'])

/** What a provider actually does here, and therefore which of the setup steps apply.
 *
 *  `laser` — books the shared laser and bills clients through Melanite. Needs a Connect account
 *  to be paid, and a medical director to be allowed to treat.
 *
 *  `room_only` — rents the treatment room by the day and brings their own clients. Melanite
 *  never handles their client money, so there is nothing to pay them and no Connect account to
 *  create; they pay for the room out of pocket at checkout. Whether they need a medical
 *  director depends on what they do in there, which is a declaration rather than something the
 *  app can know — those appointments never touch this system. */
export const practiceType = pgEnum('practice_type', ['laser', 'room_only'])

/** Where the money from this provider's appointments ends up.
 *
 *  `split` — the normal arrangement. The client pays Melanite's platform account, the
 *  provider's share is forwarded to their Connect account as a destination charge, and
 *  Melanite keeps `platform_settings.provider_share_pct` as an application fee.
 *
 *  `house` — the provider IS Melanite. There is nobody to transfer to and no share to
 *  calculate: the charge stays on the platform account, the whole amount including any tip is
 *  `melanite_cut`, and `provider_payout` is zero. Same shape training already writes.
 *
 *  A column rather than `role = 'platform_owner'` on purpose. Roles decide what somebody may
 *  SEE; this decides where money GOES, and letting a permission field carry that means a second
 *  admin who is an ordinary revenue-share provider would silently keep 100%. Same reasoning
 *  that keeps `fee_provider_share_pct` separate from `provider_share_pct`. */
export const providerRevenueModel = pgEnum('provider_revenue_model', ['split', 'house'])

export const medicalDirectorType = pgEnum('medical_director_type', ['melanite', 'own'])

/** The booking gate. `melanite` path mirrors the Stripe subscription; `own` path is set
 *  active once director info and a signed agreement are on file. */
export const medicalDirectorStatus = pgEnum('medical_director_status', [
  'none',
  'active',
  'past_due',
  'inactive',
])

export const documentType = pgEnum('document_type', [
  'training_certificate',
  'supervision_agreement',
])

export const inviteStatus = pgEnum('invite_status', ['pending', 'accepted', 'expired'])

export const bookingStatus = pgEnum('booking_status', [
  'upcoming',
  'completed',
  'cancelled',
  'no_show',
])

/** How a discount was expressed. Kept rather than collapsing to a single percentage: "10% off"
 *  and "$25 off" can produce the same price today and diverge the moment the service is
 *  repriced, so the intent is worth storing alongside the result. */
export const discountType = pgEnum('discount_type', ['none', 'percent', 'amount'])

/** v1 gap: package redemptions arrived as ordinary $0 bookings with no marker, so three
 *  separate surfaces inferred payment method from price. Now explicit. */
export const bookingPaymentSource = pgEnum('booking_payment_source', [
  'checkout_link',
  'package_redemption',
  /** Paid from a prepaid dollar balance. Set whenever ANY balance was applied, including a
   *  partial one that still left something on a card — `prepaid_redemptions.amount_applied` is
   *  the figure, and a `price` above zero says the rest was owed. */
  'prepaid',
  'comped',
  /** Paid outside the app — Groupon, Cherry, cash, a card in person. WHICH of those is on
   *  `bookings.externalMethod`, because the route and the method are different questions and
   *  v1 could answer neither: four of its five real appointments have money nobody recorded. */
  'external',
])

export const checkoutLinkStatus = pgEnum('checkout_link_status', [
  'pending',
  'paid',
  'expired',
  'cancelled',
])

export const clientPackageStatus = pgEnum('client_package_status', [
  'active',
  'exhausted',
  'expired',
  'refunded',
])

/** A provider can hold more than one of these at once, and they mean completely different
 *  things: `medical_director` is a booking gate, `epicutis` is content and wholesale access
 *  that unlocks nothing in this app. Code that touches a subscription must say which. */
/** No `expired` and no `refunded`: Keoni's decision is that a prepaid balance never expires
 *  and is never refunded, so those states cannot arise. Adding them "just in case" would
 *  invite code that handles a case the product does not have. */
export const prepaidStatus = pgEnum('prepaid_status', ['active', 'exhausted'])

export const membershipPlan = pgEnum('membership_plan', ['medical_director', 'epicutis'])

export const membershipStatus = pgEnum('membership_status', ['active', 'past_due', 'cancelled'])

export const roomSlotType = pgEnum('room_slot_type', ['full', 'am', 'pm'])

export const roomBookingStatus = pgEnum('room_booking_status', [
  /** Slot held while the provider is in Stripe Checkout. v1 had no such state: it created no
   *  row until the webhook fired, so its availability check was a read with nothing behind it
   *  and two providers could both pay for the same day. Here the row exists first and the
   *  exclusion constraint is what actually holds the slot. */
  'pending',
  'confirmed',
  'cancellation_requested',
  'cancelled',
  'refunded',
])

export const trainingCourseStatus = pgEnum('training_course_status', [
  'scheduled',
  'completed',
  'cancelled',
])

export const trainingPaymentStatus = pgEnum('training_payment_status', [
  'unpaid',
  'partial',
  'paid_in_full',
])

// --- Ledger ----------------------------------------------------------------

/** Every revenue primitive. v1 split these across three ledger tables with three different
 *  column vocabularies, plus two streams with no ledger row at all. */
export const ledgerSource = pgEnum('ledger_source', [
  'booking',
  'package',
  'room_rental',
  'membership',
  /** Epicutis is its own stream, not a flavour of `membership`. Both are provider-paid monthly
   *  subscriptions, which is where the similarity stops: one is Melanite supplying medical
   *  direction, the other is reselling access to somebody else's product. Folding them together
   *  makes every revenue report answer a question nobody asked. */
  'epicutis',
  'training',
  /** A dollar balance bought up front and spent on whatever the client books later. Its own
   *  source rather than a flavour of `package`: a package is sessions of a NAMED service, and
   *  reporting that folds the two together cannot answer "how much unspent credit is out
   *  there", which is the only question a never-expiring balance raises. */
  'prepaid',
])

/** Who handed over the money. This is what makes `SUM(melanite_cut)` mean the same thing
 *  across all five sources — see the note on `ledgerEntries`. */
export const ledgerPayer = pgEnum('ledger_payer', ['client', 'provider', 'student'])

/** Fees are their own entry types rather than purchases with an explanatory note. Keoni needs
 *  to see penalty income separately from service income, and a `note` is not something you can
 *  group by. v1 charged neither — no-show fees were "deferred to Phase 3" and never built. */
export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'purchase',
  'refund',
  'no_show_fee',
  'late_cancellation_fee',
])

export const ledgerSubjectType = pgEnum('ledger_subject_type', [
  'booking',
  'client_package',
  'room_booking',
  'membership',
  'training_enrollment',
  'prepaid_balance',
])

export const payoutStatus = pgEnum('payout_status', ['pending', 'paid', 'failed'])

/** How the money actually arrived. Not every payment routes through Stripe:
 *
 *  - `cherry` — patient financing. The client finances with Cherry, Cherry pays Melanite by
 *    ACH a day or two later, minus their merchant fee. Real revenue, normal split, no Stripe
 *    charge ever exists.
 *  - `groupon` — a voucher sold in advance and redeemed at the appointment. Groupon keeps
 *    their share and remits the rest on their own schedule.
 *  - `cash` / `check` / `other` — recorded by hand.
 *
 *  This is deliberately separate from `source`: a booking can be paid by any of these.
 *  Reconciliation against Stripe must filter to `stripe`, or manual entries read as failures
 *  forever. */
export const paymentMethod = pgEnum('payment_method', [
  'stripe',
  'cherry',
  'groupon',
  'cash',
  'check',
  'other',
])

/** How the provider's share was settled. Stripe Connect handles this automatically for
 *  Stripe-funded bookings; anything else has to be paid by hand, which is what Venmo is
 *  doing today. A payout rail, NOT a payment method — conflating the two would put money
 *  going out into the same column as money coming in. */
export const payoutMethod = pgEnum('payout_method', [
  'stripe_connect',
  'venmo',
  'cash',
  'check',
  'other',
])

// ---------------------------------------------------------------------------
// Platform configuration
// ---------------------------------------------------------------------------

/** Singleton config row. Splits are computed from these rates at write time and persisted
 *  onto the ledger entry — a rate change must never retroactively rewrite history. */
export const platformSettings = pgTable('platform_settings', {
  id: integer().primaryKey().default(1),
  providerSharePct: numeric({ precision: 4, scale: 3 }).notNull().default('0.500'),
  tipToProviderPct: numeric({ precision: 4, scale: 3 }).notNull().default('1.000'),
  noShowFeePctOfPrice: numeric({ precision: 4, scale: 3 }).notNull().default('0.500'),
  cancellationFeeAmount: money().notNull().default('50.00'),
  /** A cancellation inside this many hours is "late" and chargeable. */
  lateCancellationHours: integer().notNull().default(24),
  /** The provider's share of a penalty fee. Separate from `providerSharePct` on purpose: a
   *  fee is not a service, and the two policies should be able to diverge without one silently
   *  changing the other. Melanite splits fees evenly. */
  feeProviderSharePct: numeric({ precision: 4, scale: 3 }).notNull().default('0.500'),
  /** Stamped onto the client's consent record, so a later wording change does not rewrite what
   *  someone actually agreed to. */
  cardPolicyVersion: text().notNull().default('2026-07-27.v1'),
  /** Cherry patient-financing application link. The button is hidden until this is set —
   *  better absent than pointing nowhere. */
  cherryApplyUrl: text(),
  stripePlatformAccountId: text().notNull(),
  medicalDirectorPriceId: text(),
  /** The Epicutis membership price. Separate column rather than a shared "plans" table: there
   *  are two, they are configured once, and a table would be ceremony around two strings. */
  epicutisPriceId: text(),
  laserOpenTime: text().notNull().default('08:00'),
  laserCloseTime: text().notNull().default('20:00'),
  slotStrideMins: integer().notNull().default(15),
  roomRentalEnabled: boolean().notNull().default(false),
  /** v1 hardcoded 100 and 60 inside POST /room/rental-intent, so changing what the room costs
   *  meant editing an endpoint. Prices are configuration, not logic. */
  roomFullDayPrice: money().notNull().default('100.00'),
  roomHalfDayPrice: money().notNull().default('60.00'),
  /** Denver wall-clock bounds for the two half-day blocks. `amEnd` is also `pmStart`. */
  roomAmStart: text().notNull().default('08:00'),
  roomAmEnd: text().notNull().default('13:00'),
  roomPmEnd: text().notNull().default('18:00'),
  /** How far ahead the room can be booked. v1's 60 days, made configurable. */
  roomAdvanceDays: integer().notNull().default(60),
  packagesEnabled: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid().references(() => providers.id, { onDelete: 'set null' }),
}, (t) => [check('platform_settings_singleton', sql`${t.id} = 1`)])

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const providers = pgTable('providers', {
  id: uuid().primaryKey().defaultRandom(),
  joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

  email: text().notNull(),
  /** Null for rows migrated from Xano — its hashes are not portable (undocumented HMAC
   *  keying). Those users go through a forced reset on first login. */
  passwordHash: text(),
  requiresPasswordReset: boolean().notNull().default(false),

  firstName: text().notNull(),
  lastName: text().notNull(),
  phone: text(),
  credentials: text(),
  licenseNumber: text(),
  licenseState: text(),
  licenseExpiry: date(),
  malpracticeInsurance: text(),

  role: providerRole().notNull().default('provider'),
  status: providerStatus().notNull().default('pending'),
  /** Chosen during setup and changeable afterwards by an admin — a room renter who later wants
   *  laser time should not need a database edit. */
  practiceType: practiceType().notNull().default('laser'),
  /** What a room renter said they would perform, from `lib/room-procedures.ts`.
   *
   *  A DECLARATION, not an observation. Their appointments never touch this system, so this is
   *  the only thing that says whether a medical director is needed — and it is a record of what
   *  they told Melanite, which is the artifact that matters if anybody ever asks. */
  roomProcedures: text().array(),
  /** When they made that declaration. Without it, an empty list cannot be told apart from a
   *  question nobody has answered yet — and those need very different handling. */
  roomProceduresDeclaredAt: timestamp({ withTimezone: true }),

  /** Where this provider's client money ends up. See `providerRevenueModel`.
   *
   *  A `house` provider needs NO Connect account, and should not have one — that is the point.
   *  Every other provider defaults to `split`, so this changes nothing for them. */
  revenueModel: providerRevenueModel().notNull().default('split'),

  // Stripe Connect (money out, to the provider).
  stripeAccountId: text(),
  stripeOnboardingComplete: boolean().notNull().default(false),
  // Stripe Customer for billing the provider (money in, distinct from any client Customer).
  stripeBillingCustomerId: text(),

  medicalDirectorType: medicalDirectorType(),
  medicalDirectorStatus: medicalDirectorStatus().notNull().default('none'),

  /** Two independent booking gates, both must pass. `medicalDirectorStatus` is the
   *  subscription/credential gate; this one is a manual admin flip once Keoni has confirmed
   *  documents are on file. In v1 the equivalent check lived partly in page JS. */
  bookingEnabled: boolean().notNull().default(false),
  roomRentalEnabled: boolean().notNull().default(true),

  trainingCertDocumentId: uuid(),
  onboardingStep: integer().notNull().default(0),
  lastLoginAt: timestamp({ withTimezone: true }),
  policyAckAt: timestamp({ withTimezone: true }),
  policyAckVersion: text(),

  // Notification preferences. Kept inline rather than split out: they are 1:1, always
  // present, and cheap. The sparse `md_*` credential block is what got its own table.
  notifyBookingConfirmed: boolean().notNull().default(true),
  notifyPayoutDeposited: boolean().notNull().default(true),
  notifyAppointmentReminders: boolean().notNull().default(true),
  notifyNewAvailability: boolean().notNull().default(true),
  notifyMembershipBilling: boolean().notNull().default(true),
}, (t) => [
  uniqueIndex().on(t.email),
  index().on(t.status),
  index().on(t.role),
  index().on(t.stripeAccountId),
])

/** The "own medical director" path only — 8 sparse columns that were inline on `providers`
 *  in v1 and are null for every provider on the Melanite subscription path. */
export const medicalDirectorCredentials = pgTable('medical_director_credentials', {
  providerId: uuid()
    .primaryKey()
    .references(() => providers.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  npi: text(),
  licenseNumber: text(),
  licenseState: text(),
  licenseExpiry: date(),
  credentials: text(),
  contactEmail: text(),
  contactPhone: text(),
  agreementDocumentId: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/** v1 used Xano's `attachment` type. v2 stores an object-storage key and resolves URLs at
 *  read time, so the file store can change without a data migration. */
export const documents = pgTable('documents', {
  id: uuid().primaryKey().defaultRandom(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  docType: documentType().notNull(),
  storageKey: text().notNull(),
  originalFilename: text(),
  mimeType: text(),
  sizeBytes: integer(),
  uploadedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index().on(t.providerId, t.docType)])

export const inviteLinks = pgTable('invite_links', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  email: text().notNull(),
  invitedByAdminId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  token: text().notNull(),
  status: inviteStatus().notNull().default('pending'),
  sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  acceptedAt: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex().on(t.token), index().on(t.email), index().on(t.status)])

/** Database-backed sessions, so revocation is immediate. That matters here: `status`,
 *  `bookingEnabled` and `medicalDirectorStatus` are live gates, and a stateless token would
 *  keep a deactivated provider signed in until it expired.
 *
 *  The cookie carries a random token; only its SHA-256 hash is stored. A leak of this table
 *  therefore yields nothing usable, the same reasoning that applies to password hashes. */
export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  userAgent: text(),
  ipAddress: text(),
}, (t) => [
  uniqueIndex().on(t.tokenHash),
  index().on(t.providerId),
  index().on(t.expiresAt),
])

/** Single-use password reset tokens. Like sessions, only the hash is stored — a leak of this
 *  table must not hand anyone a working reset link, which is exactly an account takeover.
 *
 *  v1 tracked a `status` enum (pending/used/expired); `usedAt` plus `expiresAt` says the same
 *  thing without a field that can disagree with the timestamps. */
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid().primaryKey().defaultRandom(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull(),
  sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex().on(t.tokenHash), index().on(t.providerId)])

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** New in v2. v1 had no client entity — `client_packages` keyed off a lowercased email
 *  string, so a typo silently split a package balance, and honouring a deletion request
 *  meant scanning every table. Scope is deliberately minimal: exactly the fields v1 already
 *  collected. Clients belong to the provider; this is not a CRM. */
export const clients = pgTable('clients', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  email: text(),
  name: text(),
  phone: text(),
  /** Stripe Customer for card-on-file. Distinct from `providers.stripeBillingCustomerId`.
   *  Lives on the PLATFORM account, not the provider's connected account, because Melanite is
   *  the party that charges no-show fees and splits them. */
  stripeCustomerId: text(),

  /** The saved card, for charging no-shows and late cancellations off-session.
   *
   *  Brand and last four are stored only to show the client and Keoni WHICH card is on file.
   *  Nothing else about the card is retained, and none of it ever reaches this server as raw
   *  data — Stripe Elements collects it directly. */
  defaultPaymentMethodId: text(),
  /** Stripe's payment method type — `card`, `link`, and so on. Recorded because it decides how
   *  the saved method can be described: a Link method carries no card object at all, so brand
   *  and last four are null and "•••• ????" is the only thing brand-and-last-four logic can
   *  produce. Found by paying through Link in the sandbox and getting four nulls back. */
  paymentMethodType: text(),
  cardBrand: text(),
  cardLast4: text(),
  cardExpMonth: integer(),
  cardExpYear: integer(),
  /** When the client authorised future charges, and to what wording. This is the artifact that
   *  makes an off-session charge defensible — without it there is a card on file and no record
   *  that anyone agreed to it being used. */
  cardOnFileConsentAt: timestamp({ withTimezone: true }),
  cardOnFileConsentVersion: text(),
}, (t) => [uniqueIndex().on(t.email), index().on(t.phone)])

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

export const services = pgTable('services', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  name: text().notNull(),
  description: text(),
  suggestedDurationMins: integer().notNull(),
  minDurationMins: integer().notNull(),
  maxDurationMins: integer().notNull(),
  packageEligible: boolean().notNull().default(false),
  /** Ablative lasers (CO2, Erbium) need training beyond the standard RN/NP/PA license. */
  advancedTierRequired: boolean().notNull().default(false),
  /** How the catalogue is grouped when somebody has to pick from it.
   *
   *  Presentation, not policy — nothing is gated on it. It exists because laser hair removal
   *  went from four sizes to twelve named body areas, which turned every service dropdown into
   *  a flat list of twenty-odd options where the twelve that belong together are only adjacent
   *  by luck of the alphabet.
   *
   *  Free text rather than an enum: adding a group is a catalogue decision, not a schema one,
   *  and an enum would need a migration to sell something new. Null means ungrouped, which
   *  renders last rather than disappearing. */
  category: text(),
  colorHex: text(),
  active: boolean().notNull().default(true),
}, (t) => [index().on(t.active)])

/** A provider's own price, duration and on/off toggle for a catalog service. */
export const providerServices = pgTable('provider_services', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  serviceId: uuid()
    .notNull()
    .references(() => services.id, { onDelete: 'restrict' }),
  price: money().notNull(),
  durationMins: integer().notNull(),
  isActive: boolean().notNull().default(true),
}, (t) => [uniqueIndex().on(t.providerId, t.serviceId), index().on(t.providerId, t.isActive)])

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

/** One appointment on the single shared laser. Availability is global — any provider's
 *  booking blocks the slot platform-wide. */
export const bookings = pgTable('bookings', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  providerServiceId: uuid()
    .notNull()
    .references(() => providerServices.id, { onDelete: 'restrict' }),

  /** Nullable so ETL and walk-ins are never blocked on resolving an identity. */
  clientId: uuid().references(() => clients.id, { onDelete: 'set null' }),
  // Point-in-time snapshot of who attended. Not a cache of `clients` — the name on the
  // appointment record should not change because someone later edited a client row.
  clientName: text().notNull(),
  clientPhone: text(),
  clientEmail: text(),

  treatmentArea: text(),
  notes: text(),

  originalPrice: money().notNull(),
  /** What kind of discount the provider applied, and the figure they typed. `price` is the
   *  result; these two record how it was arrived at. */
  discountType: discountType().notNull().default('none'),
  discountValue: numeric({ precision: 10, scale: 2 }).notNull().default('0'),
  price: money().notNull(),
  paymentSource: bookingPaymentSource().notNull(),
  /** Which external route, when `paymentSource` is 'external'.
   *
   *  Deliberately the same enum the ledger uses, so "Groupon" means one thing in the app. The
   *  direction of the money differs by method and that is worth knowing: a Stripe booking pays
   *  the provider automatically via destination charge, but a Groupon voucher is collected BY
   *  the provider, so Melanite's share becomes something Keoni has to invoice back. */
  externalMethod: paymentMethod(),

  durationMins: integer().notNull(),
  startTime: timestamp({ withTimezone: true }).notNull(),
  endTime: timestamp({ withTimezone: true }).notNull(),
  status: bookingStatus().notNull().default('upcoming'),

  googleCalendarEventId: text(),
  policyAckAt: timestamp({ withTimezone: true }),
  policyAckVersion: text(),

  /** A no-show or late-cancellation fee that was attempted and did not go through — a declined
   *  card, no card on file, no consent.
   *
   *  Stamped on the booking rather than kept in a separate queue table: the fact belongs to this
   *  appointment, and a parallel work-queue store is one more thing that can disagree with
   *  reality. Cleared when the fee is later charged or deliberately waived. */
  feeChargeFailedAt: timestamp({ withTimezone: true }),
  feeChargeError: text(),
  /** Set when someone decides not to pursue the fee. Distinguishes "handled, no" from "nobody
   *  has looked at it", which is the entire point of a review queue. */
  feeWaivedAt: timestamp({ withTimezone: true }),
  feeWaivedBy: uuid().references(() => providers.id, { onDelete: 'set null' }),
}, (t) => [
  index().on(t.providerId, t.startTime),
  index().on(t.startTime, t.endTime),
  index().on(t.status),
  index().on(t.clientId),
  check('bookings_time_order', sql`${t.endTime} > ${t.startTime}`),
])

/** Token-authenticated public checkout, 1:1 with a booking. */
export const checkoutLinks = pgTable('checkout_links', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  bookingId: uuid()
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  token: text().notNull(),
  status: checkoutLinkStatus().notNull().default('pending'),
  /** When the client left for Cherry to finance this appointment.
   *
   *  Same meaning as on `packageCheckoutLinks` — an INTENT, not a payment. The client finishes
   *  on Cherry's site and Cherry pays Melanite directly, so no webhook ever arrives here and
   *  the link would otherwise sit at `pending` looking exactly like one nobody opened.
   *
   *  This column was ONCE here by mistake, added while building package financing when only
   *  packages could be financed — the two tables have near-identical column lists, so nothing
   *  complained and the value was written where nothing read it. `db:verify` grew a check
   *  asserting its absence. It is here deliberately now: appointments can be financed too, and
   *  that check has been replaced with one that tests the thing that actually went wrong. */
  cherryStartedAt: timestamp({ withTimezone: true }),
  tipAmount: money().notNull().default('0.00'),
  stripeCustomerId: text(),
  stripePaymentIntentId: text(),
  paidAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex().on(t.token),
  uniqueIndex().on(t.bookingId),
  index().on(t.status),
  index().on(t.stripePaymentIntentId),
])

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/** What a provider sells. Soft-deleted via `active`, never removed — sold packages
 *  reference the template they came from. */
export const packageTemplates = pgTable('package_templates', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  description: text(),
  totalPrice: money().notNull().default('0.00'),
  expiresAfterDays: integer(),
  active: boolean().notNull().default(true),
}, (t) => [index().on(t.providerId, t.active)])

export const packageTemplateItems = pgTable('package_template_items', {
  id: uuid().primaryKey().defaultRandom(),
  packageTemplateId: uuid()
    .notNull()
    .references(() => packageTemplates.id, { onDelete: 'cascade' }),
  serviceId: uuid()
    .notNull()
    .references(() => services.id, { onDelete: 'restrict' }),
  quantity: integer().notNull().default(1),
  perSessionValue: money().notNull().default('0.00'),
}, (t) => [uniqueIndex().on(t.packageTemplateId, t.serviceId)])

/** A purchased package instance. */
export const clientPackages = pgTable('client_packages', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  /** Required — the durable balance identity that v1 approximated with an email string. */
  clientId: uuid()
    .notNull()
    .references(() => clients.id, { onDelete: 'restrict' }),
  packageTemplateId: uuid()
    .notNull()
    .references(() => packageTemplates.id, { onDelete: 'restrict' }),
  status: clientPackageStatus().notNull().default('active'),
  purchasedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
}, (t) => [index().on(t.clientId, t.status), index().on(t.providerId, t.status)])

/** Per-instance balances, snapshotted from the template at purchase so later template
 *  edits never rewrite a sold package. */
export const clientPackageItems = pgTable('client_package_items', {
  id: uuid().primaryKey().defaultRandom(),
  clientPackageId: uuid()
    .notNull()
    .references(() => clientPackages.id, { onDelete: 'cascade' }),
  serviceId: uuid()
    .notNull()
    .references(() => services.id, { onDelete: 'restrict' }),
  perSessionValue: money().notNull().default('0.00'),
  qtyTotal: integer().notNull().default(1),
  qtyUsed: integer().notNull().default(0),
}, (t) => [
  uniqueIndex().on(t.clientPackageId, t.serviceId),
  check('client_package_items_qty', sql`${t.qtyUsed} >= 0 AND ${t.qtyUsed} <= ${t.qtyTotal}`),
])

/** Append-only: one row per session consumed. `voidedAt` set means the booking was
 *  cancelled and the session returned to the package — the row is kept for audit but must
 *  be excluded from balance math. */
export const packageRedemptions = pgTable('package_redemptions', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  clientPackageId: uuid()
    .notNull()
    .references(() => clientPackages.id, { onDelete: 'cascade' }),
  clientPackageItemId: uuid()
    .notNull()
    .references(() => clientPackageItems.id, { onDelete: 'cascade' }),
  bookingId: uuid()
    .notNull()
    .references(() => bookings.id, { onDelete: 'restrict' }),
  /** Power the "Session 3 of 6 · Laser 2 of 3" display. */
  overallIndex: integer().notNull(),
  serviceIndex: integer().notNull(),
  redeemedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  voidedAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.clientPackageId),
  uniqueIndex().on(t.bookingId),
])

/** Package purchase links. Separate from `checkoutLinks`, which is 1:1 with a booking. */
export const packageCheckoutLinks = pgTable('package_checkout_links', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  token: text().notNull(),
  packageTemplateId: uuid()
    .notNull()
    .references(() => packageTemplates.id, { onDelete: 'restrict' }),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  clientId: uuid().references(() => clients.id, { onDelete: 'set null' }),
  clientName: text(),
  clientEmail: text(),
  clientPhone: text(),
  /** The price quoted when the link was sent, snapshotted from the template.
   *
   *  Without this, editing a template between sending a link and the client paying silently
   *  changes what they are charged — the client sees one number in a text message and another
   *  at checkout, and nothing records that it moved. */
  price: money().notNull().default('0.00'),
  status: checkoutLinkStatus().notNull().default('pending'),
  /** When the client left for Cherry.
   *
   *  Cherry is a hand-off: the client finishes on Cherry's site and the money reaches Keoni
   *  directly, so no webhook ever arrives here. Without this the link sits at `pending`
   *  forever and looks identical to one nobody opened — the copy on that page literally says
   *  "then tell your provider", which is a workflow held together by somebody remembering.
   *
   *  An INTENT, not a payment. It records that they went, not that they paid. */
  cherryStartedAt: timestamp({ withTimezone: true }),
  tipAmount: money().notNull().default('0.00'),
  stripeCustomerId: text(),
  stripePaymentIntentId: text(),
  /** The package this link produced, once paid. */
  clientPackageId: uuid().references(() => clientPackages.id, { onDelete: 'set null' }),
  paidAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex().on(t.token),
  index().on(t.providerId, t.status),
  index().on(t.stripePaymentIntentId),
])

// ---------------------------------------------------------------------------
// Prepaid balances
// ---------------------------------------------------------------------------

/** Money paid up front and spent later on whatever the client books.
 *
 *  NOT a package. A package is N sessions of a NAMED service; this is a dollar amount good for
 *  anything. The distinction was Keoni's and it is about who carries a price rise: a client who
 *  prepaid a session owns that session whatever it later costs, whereas a client holding $200
 *  gets $200 of whatever the price is on the day. She wanted the second, so the provider is not
 *  out of pocket on a balance that sits for a year.
 *
 *  Never expires and is never refunded, both decided 2026-08-18. `purchasedAt` is therefore not
 *  decoration: it is the only date this row has, and it is what any future unclaimed-property
 *  rule would key on.
 */
export const prepaidBalances = pgTable('prepaid_balances', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Scoped to the provider it was bought from. The split is paid out at PURCHASE, so another
   *  provider redeeming it would be working against money already sitting in someone else's
   *  Stripe account. */
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  /** The beneficiary, not the payer. A gift is bought by one person for another, and it is this
   *  column that makes "link their payment under a specific client" true. */
  clientId: uuid()
    .notNull()
    .references(() => clients.id, { onDelete: 'restrict' }),

  originalAmount: money().notNull(),
  /** Stored rather than derived from the redemptions.
   *
   *  The rest of this codebase prefers deriving, and for reporting that is right. This one is
   *  a claim: two bookings must not spend the same dollar, so it is decremented by a
   *  conditional UPDATE that only succeeds while the money is there — exactly what
   *  `client_package_items.qty_used` does for a session, and for the same race. */
  remainingAmount: money().notNull(),

  purchasedAt: timestamp({ withTimezone: true }),
  status: prepaidStatus().notNull().default('active'),

  /** Who paid, when that is not the beneficiary. Recorded because a gift is the one case where
   *  the person on the Stripe receipt is not the person holding the balance, and "who bought
   *  this" is unanswerable from `clients` alone. */
  purchaserName: text(),
  purchaserEmail: text(),
}, (t) => [
  index().on(t.clientId, t.status),
  index().on(t.providerId, t.status),
  // Oldest-first spending reads this.
  index().on(t.clientId, t.purchasedAt),
  check(
    'prepaid_balances_remaining_in_range',
    sql`${t.remainingAmount} >= 0 AND ${t.remainingAmount} <= ${t.originalAmount}`,
  ),
])

/** Append-only: one row per booking that drew on a balance.
 *
 *  `voidedAt` set means the booking was cancelled and the money went back — the row stays for
 *  audit and must be excluded from any total. Same shape as `package_redemptions`, and for the
 *  same reason: deleting the row would erase the fact that the money ever moved. */
export const prepaidRedemptions = pgTable('prepaid_redemptions', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  prepaidBalanceId: uuid()
    .notNull()
    .references(() => prepaidBalances.id, { onDelete: 'cascade' }),
  bookingId: uuid()
    .notNull()
    .references(() => bookings.id, { onDelete: 'restrict' }),
  /** What this booking actually took. Not the service price — a $250 service against a $180
   *  balance applies $180 and leaves $70 on a card. */
  amountApplied: money().notNull(),
  redeemedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  voidedAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.prepaidBalanceId),
  index().on(t.bookingId),
  // One draw per booking PER BALANCE, not one per booking.
  //
  // package_redemptions is unique on booking_id alone and that is right for it — a booking
  // consumes exactly one session. This is money, and oldest-first spending means a $220
  // service can legitimately draw $50 off one balance and $170 off the next. Keying on the
  // booking alone would refuse the second row and reject precisely the case the feature
  // exists for, while still leaving the first balance debited.
  uniqueIndex().on(t.bookingId, t.prepaidBalanceId),
  check('prepaid_redemptions_amount_positive', sql`${t.amountApplied} > 0`),
])

/** Purchase links, mirroring `packageCheckoutLinks`. */
export const prepaidCheckoutLinks = pgTable('prepaid_checkout_links', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  token: text().notNull(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  /** Resolved when the link is CREATED, not from whoever pays it. That is the whole of the
   *  gifting requirement — a mother can pay her daughter's link and the balance is the
   *  daughter's. */
  clientId: uuid()
    .notNull()
    .references(() => clients.id, { onDelete: 'restrict' }),

  /** The amount quoted when the link was sent. Snapshotted for the same reason the package
   *  link snapshots its price: the client sees a number in a text message and must be charged
   *  that number. */
  amount: money().notNull(),

  purchaserName: text(),
  purchaserEmail: text(),

  status: checkoutLinkStatus().notNull().default('pending'),
  stripeCustomerId: text(),
  stripePaymentIntentId: text(),
  /** The balance this link produced, once paid. */
  prepaidBalanceId: uuid().references(() => prepaidBalances.id, { onDelete: 'set null' }),
  paidAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex().on(t.token),
  index().on(t.providerId, t.status),
  index().on(t.stripePaymentIntentId),
])

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

/** The $150/mo medical-director subscription. In v1 this generated revenue that existed
 *  only in Stripe — no ledger row anywhere. Now it writes to `ledgerEntries` per invoice. */
export const memberships = pgTable('memberships', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'cascade' }),
  plan: membershipPlan().notNull().default('medical_director'),
  status: membershipStatus().notNull().default('active'),
  stripeSubscriptionId: text(),
  stripeCustomerId: text(),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  startDate: timestamp({ withTimezone: true }),
  renewalDate: timestamp({ withTimezone: true }),
  cancelDate: timestamp({ withTimezone: true }),
}, (t) => [
  uniqueIndex().on(t.stripeSubscriptionId),
  index().on(t.providerId, t.status),
  // One row per provider per plan. Without this a retried webhook or a resubscribe leaves two
  // `epicutis` rows and every lookup picks whichever comes back first.
  uniqueIndex('memberships_provider_plan_unique').on(t.providerId, t.plan),
])

// ---------------------------------------------------------------------------
// Room rental
// ---------------------------------------------------------------------------

/** Daily room rental. The provider pays Melanite, so this is platform-inbound revenue —
 *  `ledgerEntries.payer = 'provider'` and the whole amount is `melaniteCut`.
 *
 *  v1 carried an `active_slot_key` text column ("<date>:<slot>", nulled on cancel) purely
 *  to get a partial unique index out of a plain unique index. Postgres does this properly.
 *
 *  Occupancy is enforced by an EXCLUDE constraint on the time range rather than by any
 *  combination of (date, slot_type) — see `room_bookings_no_overlap` in migration 0008. A
 *  unique index on (date, slot_type) looks right and is not: it stops two `am` bookings but
 *  happily lets `full` be sold on a day that already has one. The room is a physical space
 *  with a start and an end, so overlap is the actual rule, and the ranges already exist in
 *  `startAt`/`endAt`. */
export const roomBookings = pgTable('room_bookings', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  providerId: uuid()
    .notNull()
    .references(() => providers.id, { onDelete: 'restrict' }),
  rentalDate: date().notNull(),
  slotType: roomSlotType().notNull().default('full'),
  price: money().notNull().default('0.00'),
  status: roomBookingStatus().notNull().default('pending'),
  startAt: timestamp({ withTimezone: true }).notNull(),
  endAt: timestamp({ withTimezone: true }).notNull(),
  cancelledAt: timestamp({ withTimezone: true }),

  /** Needed to refund on cancellation. v1 stored this and v2's table did not, which would have
   *  left the cancel flow with nothing to call Stripe with. */
  stripePaymentIntentId: text(),
  stripeCheckoutSessionId: text(),
  /** When an unpaid hold stops blocking the slot. Without this an abandoned checkout would
   *  take the room off the market permanently. */
  holdExpiresAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.providerId),
  index().on(t.rentalDate),
  index().on(t.status),
  index().on(t.stripePaymentIntentId),
])

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export const trainingCourses = pgTable('training_courses', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  day1Date: date().notNull(),
  day1Start: text().notNull().default('10:00'),
  day1End: text().notNull().default('16:00'),
  day2Date: date(),
  day2Start: text().notNull().default('10:00'),
  day2End: text().notNull().default('14:00'),
  maxStudents: integer().notNull().default(5),
  /** Seats actually claimed, maintained by an atomic conditional UPDATE rather than derived by
   *  counting enrolments.
   *
   *  Counting was the bug. The old check read `count(*) where payment_status <> 'unpaid'` and
   *  compared it to maxStudents — but the seat is not taken until Stripe confirms the payment,
   *  which is minutes later. Two people could both pass the check, both pay, and both be
   *  enrolled on the last seat. A counter incremented under a row lock closes that: concurrent
   *  claims serialise on the course row, and the loser sees the course full. */
  seatsTaken: integer().notNull().default(0),
  depositAmount: money().notNull().default('500.00'),
  totalPrice: money().notNull().default('1400.00'),
  googleCalendarEventIdDay1: text(),
  googleCalendarEventIdDay2: text(),
  status: trainingCourseStatus().notNull().default('scheduled'),
}, (t) => [index().on(t.status), index().on(t.day1Date)])

/** A student's enrolment. `providerId` is nullable because students typically are not
 *  providers yet — training is how they become one.
 *
 *  v1 denormalized the money onto this row (`deposit_amount`, `amount_paid`, `balance_due`,
 *  two Stripe intent ids) with no ledger entry, which is why training revenue never
 *  appeared in any admin total. Payments now write to `ledgerEntries`; the columns kept
 *  here are enrolment state, not the money record. */
export const trainingEnrollments = pgTable('training_enrollments', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  trainingCourseId: uuid()
    .notNull()
    .references(() => trainingCourses.id, { onDelete: 'restrict' }),
  providerId: uuid().references(() => providers.id, { onDelete: 'set null' }),
  inviteLinkId: uuid().references(() => inviteLinks.id, { onDelete: 'set null' }),

  firstName: text().notNull(),
  lastName: text().notNull(),
  email: text().notNull(),
  phone: text(),
  licenseNumber: text(),

  paymentStatus: trainingPaymentStatus().notNull().default('unpaid'),
  /** When an unpaid seat stops being held.
   *
   *  The same shape as `roomBookings.holdExpiresAt`, and for the same reason: without it an
   *  abandoned checkout takes a seat off the market permanently. Cleared once payment lands,
   *  at which point the seat is held by the payment rather than by the clock. */
  seatHeldUntil: timestamp({ withTimezone: true }),
  /** When the student left to apply through Cherry.
   *
   *  An INTENT, not a payment — the same distinction `packageCheckoutLinks.cherryStartedAt`
   *  draws, and for the same reason: the client finishes on Cherry's site, Cherry pays Melanite
   *  by ACH days later, and no webhook ever arrives here. Without this the enrolment sits at
   *  `unpaid` looking exactly like an abandoned form.
   *
   *  It also justifies a much longer seat hold. Twenty minutes is right for somebody typing a
   *  card number; a financing decision takes days, and letting the seat evaporate meanwhile
   *  means an approved student finds the course full. */
  cherryStartedAt: timestamp({ withTimezone: true }),
  balanceDueDate: date(),
  courseCompletedAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.trainingCourseId),
  index().on(t.email),
  index().on(t.providerId),
])

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** Append-only money ledger — one row per payment, across every revenue primitive.
 *  Replaces v1's `transactions`, `package_transactions` and `room_transactions`, and adds
 *  the two streams that had no ledger at all (membership, training).
 *
 *  The `payer` column is what lets one expression work for every source. For client-paid
 *  revenue (booking, package) the money splits and the platform keeps `melaniteCut`. For
 *  provider-paid revenue (room rental, membership) there is no split — `providerPayout` is
 *  0 and `melaniteCut` is the whole amount. So:
 *
 *      platform revenue  = SUM(melanite_cut)                        -- all five sources
 *      provider earnings = SUM(provider_payout)
 *      provider charges  = SUM(gross_amount) WHERE payer = 'provider'
 *
 *  Splits are computed from `platformSettings` at write time and persisted here; a rate
 *  change must not rewrite history. Stripe remains the source of truth for money movement —
 *  the ids on every row exist so this can be reconciled against it.
 *
 *  Rows are never updated except to stamp payout status. Corrections are `refund` rows. */
export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid().primaryKey().defaultRandom(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

  source: ledgerSource().notNull(),
  payer: ledgerPayer().notNull(),
  entryType: ledgerEntryType().notNull().default('purchase'),

  /** Polymorphic subject — no FK, since it points at one of five tables. Always set
   *  together with `subjectId`. */
  subjectType: ledgerSubjectType().notNull(),
  subjectId: uuid().notNull(),

  /** Null only for training enrolments by students who are not yet providers. */
  providerId: uuid().references(() => providers.id, { onDelete: 'restrict' }),
  clientId: uuid().references(() => clients.id, { onDelete: 'set null' }),
  /** Denormalized for per-service revenue reporting. v1 resolved this with an N+1
   *  `booking → provider_service → service` lookup inside the aggregation loop. */
  serviceId: uuid().references(() => services.id, { onDelete: 'set null' }),

  grossAmount: money().notNull().default('0.00'),
  tipAmount: money().notNull().default('0.00'),
  /** Split is stored explicitly rather than derived, so an arrangement that differs from the
   *  platform default is representable without a schema change. A Groupon voucher the
   *  provider sells directly is `providerPayout = gross, melaniteCut = 0`; one Melanite
   *  receives carries the normal split. The row records what happened. */
  providerPayout: money().notNull().default('0.00'),
  melaniteCut: money().notNull().default('0.00'),

  paymentMethod: paymentMethod().notNull().default('stripe'),
  /** Their identifier — Cherry contract id, Groupon voucher code, cheque number. Nothing
   *  reads this yet; it exists so a statement import can reconcile against it later without
   *  a backfill. */
  externalReference: text(),

  stripePaymentIntentId: text(),
  stripeTransferId: text(),
  stripeRefundId: text(),
  stripeInvoiceId: text(),

  payoutStatus: payoutStatus().notNull().default('pending'),
  payoutMethod: payoutMethod().notNull().default('stripe_connect'),
  payoutReference: text(),
  payoutDate: date(),

  note: text(),
  /** Who entered this by hand. Null for anything machine-generated, which is also how you
   *  tell a recorded payment from an observed one. */
  recordedBy: uuid().references(() => providers.id, { onDelete: 'set null' }),
}, (t) => [
  index().on(t.createdAt.desc()),
  index().on(t.providerId, t.createdAt.desc()),
  index().on(t.source, t.createdAt.desc()),
  index().on(t.subjectType, t.subjectId),
  index().on(t.clientId),
  index().on(t.payoutStatus),
  index().on(t.paymentMethod),
  // One PURCHASE per payment intent — the guard against a Stripe retry writing the same
  // payment twice.
  //
  // Deliberately NOT extended to refunds. Stripe reports `amount_refunded` cumulatively, so a
  // partially refunded charge produces a second, third, nth refund event, each of which must
  // write the delta as its own row. An earlier version keyed this on (intent, entry_type),
  // which allowed exactly one refund and made the second one fail — caught by sending two
  // partial refunds through the webhook. Refund idempotency comes from comparing the
  // cumulative total against what is already recorded, not from an index.
  uniqueIndex()
    .on(t.stripePaymentIntentId)
    .where(sql`${t.stripePaymentIntentId} IS NOT NULL AND ${t.entryType} <> 'refund'`),
  // The same guarantee for invoices, which subscription revenue arrives on and which have no
  // payment intent of their own.
  //
  // Its absence was real, not theoretical: the handler read "has this invoice been recorded?"
  // and inserted if not, and two deliveries of the same invoice raced that gap. Caught by
  // paying for a subscription through the CLI and finding TWO $95 rows — revenue double
  // counted, silently, on the one table the whole business is measured from.
  uniqueIndex('ledger_entries_stripe_invoice_id_unique')
    .on(t.stripeInvoiceId)
    .where(sql`${t.stripeInvoiceId} IS NOT NULL AND ${t.entryType} <> 'refund'`),
  // A Stripe-funded entry must carry its payment intent — that link is what makes
  // reconciliation possible, and an entry claiming to be Stripe without one is either a data
  // error or a manual entry mislabelled. Membership entries are the exception: they come
  // from invoices, which have no payment intent of their own.
  check(
    'ledger_entries_stripe_needs_reference',
    sql`${t.paymentMethod} <> 'stripe'
        OR ${t.stripePaymentIntentId} IS NOT NULL
        OR ${t.stripeInvoiceId} IS NOT NULL`,
  ),
  check(
    'ledger_entries_provider_paid_is_unsplit',
    sql`${t.payer} <> 'provider' OR (${t.providerPayout} = 0 AND ${t.melaniteCut} = ${t.grossAmount})`,
  ),
])

// ---------------------------------------------------------------------------
// Operational
// ---------------------------------------------------------------------------

/** Raw webhook receipts, for replay and idempotency. v1 routed Stripe through four
 *  separate endpoints; v2 should land them in one place. */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid().primaryKey().defaultRandom(),
  receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  destination: text().notNull(),
  eventType: text(),
  eventId: text(),
  payload: jsonb(),
  signatureVerified: boolean().notNull().default(false),
  processedAt: timestamp({ withTimezone: true }),
  error: text(),
}, (t) => [uniqueIndex().on(t.eventId), index().on(t.receivedAt.desc())])

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const providersRelations = relations(providers, ({ one, many }) => ({
  medicalDirectorCredentials: one(medicalDirectorCredentials),
  providerServices: many(providerServices),
  bookings: many(bookings),
  ledgerEntries: many(ledgerEntries),
  packageTemplates: many(packageTemplates),
  memberships: many(memberships),
  roomBookings: many(roomBookings),
  documents: many(documents),
}))

export const medicalDirectorCredentialsRelations = relations(
  medicalDirectorCredentials,
  ({ one }) => ({
    provider: one(providers, {
      fields: [medicalDirectorCredentials.providerId],
      references: [providers.id],
    }),
  }),
)

export const clientsRelations = relations(clients, ({ many }) => ({
  bookings: many(bookings),
  clientPackages: many(clientPackages),
  ledgerEntries: many(ledgerEntries),
}))

export const servicesRelations = relations(services, ({ many }) => ({
  providerServices: many(providerServices),
  ledgerEntries: many(ledgerEntries),
}))

export const providerServicesRelations = relations(providerServices, ({ one, many }) => ({
  provider: one(providers, {
    fields: [providerServices.providerId],
    references: [providers.id],
  }),
  service: one(services, {
    fields: [providerServices.serviceId],
    references: [services.id],
  }),
  bookings: many(bookings),
}))

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  provider: one(providers, { fields: [bookings.providerId], references: [providers.id] }),
  providerService: one(providerServices, {
    fields: [bookings.providerServiceId],
    references: [providerServices.id],
  }),
  client: one(clients, { fields: [bookings.clientId], references: [clients.id] }),
  checkoutLink: one(checkoutLinks),
  redemption: one(packageRedemptions),
  prepaidRedemption: one(prepaidRedemptions),
  ledgerEntries: many(ledgerEntries),
}))

export const checkoutLinksRelations = relations(checkoutLinks, ({ one }) => ({
  booking: one(bookings, { fields: [checkoutLinks.bookingId], references: [bookings.id] }),
}))

export const packageTemplatesRelations = relations(packageTemplates, ({ one, many }) => ({
  provider: one(providers, {
    fields: [packageTemplates.providerId],
    references: [providers.id],
  }),
  items: many(packageTemplateItems),
  clientPackages: many(clientPackages),
}))

export const packageTemplateItemsRelations = relations(packageTemplateItems, ({ one }) => ({
  template: one(packageTemplates, {
    fields: [packageTemplateItems.packageTemplateId],
    references: [packageTemplates.id],
  }),
  service: one(services, {
    fields: [packageTemplateItems.serviceId],
    references: [services.id],
  }),
}))

export const clientPackagesRelations = relations(clientPackages, ({ one, many }) => ({
  provider: one(providers, { fields: [clientPackages.providerId], references: [providers.id] }),
  client: one(clients, { fields: [clientPackages.clientId], references: [clients.id] }),
  template: one(packageTemplates, {
    fields: [clientPackages.packageTemplateId],
    references: [packageTemplates.id],
  }),
  items: many(clientPackageItems),
  redemptions: many(packageRedemptions),
}))

export const clientPackageItemsRelations = relations(clientPackageItems, ({ one, many }) => ({
  clientPackage: one(clientPackages, {
    fields: [clientPackageItems.clientPackageId],
    references: [clientPackages.id],
  }),
  service: one(services, { fields: [clientPackageItems.serviceId], references: [services.id] }),
  redemptions: many(packageRedemptions),
}))

export const packageRedemptionsRelations = relations(packageRedemptions, ({ one }) => ({
  clientPackage: one(clientPackages, {
    fields: [packageRedemptions.clientPackageId],
    references: [clientPackages.id],
  }),
  item: one(clientPackageItems, {
    fields: [packageRedemptions.clientPackageItemId],
    references: [clientPackageItems.id],
  }),
  booking: one(bookings, { fields: [packageRedemptions.bookingId], references: [bookings.id] }),
}))

export const prepaidBalancesRelations = relations(prepaidBalances, ({ one, many }) => ({
  provider: one(providers, { fields: [prepaidBalances.providerId], references: [providers.id] }),
  client: one(clients, { fields: [prepaidBalances.clientId], references: [clients.id] }),
  redemptions: many(prepaidRedemptions),
}))

export const prepaidRedemptionsRelations = relations(prepaidRedemptions, ({ one }) => ({
  balance: one(prepaidBalances, {
    fields: [prepaidRedemptions.prepaidBalanceId],
    references: [prepaidBalances.id],
  }),
  booking: one(bookings, { fields: [prepaidRedemptions.bookingId], references: [bookings.id] }),
}))

export const prepaidCheckoutLinksRelations = relations(prepaidCheckoutLinks, ({ one }) => ({
  provider: one(providers, {
    fields: [prepaidCheckoutLinks.providerId],
    references: [providers.id],
  }),
  client: one(clients, { fields: [prepaidCheckoutLinks.clientId], references: [clients.id] }),
  balance: one(prepaidBalances, {
    fields: [prepaidCheckoutLinks.prepaidBalanceId],
    references: [prepaidBalances.id],
  }),
}))

export const membershipsRelations = relations(memberships, ({ one }) => ({
  provider: one(providers, { fields: [memberships.providerId], references: [providers.id] }),
}))

export const roomBookingsRelations = relations(roomBookings, ({ one }) => ({
  provider: one(providers, { fields: [roomBookings.providerId], references: [providers.id] }),
}))

export const trainingCoursesRelations = relations(trainingCourses, ({ many }) => ({
  enrollments: many(trainingEnrollments),
}))

export const trainingEnrollmentsRelations = relations(trainingEnrollments, ({ one }) => ({
  course: one(trainingCourses, {
    fields: [trainingEnrollments.trainingCourseId],
    references: [trainingCourses.id],
  }),
  provider: one(providers, {
    fields: [trainingEnrollments.providerId],
    references: [providers.id],
  }),
}))

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  provider: one(providers, { fields: [ledgerEntries.providerId], references: [providers.id] }),
  client: one(clients, { fields: [ledgerEntries.clientId], references: [clients.id] }),
  service: one(services, { fields: [ledgerEntries.serviceId], references: [services.id] }),
}))
