// Seeds Neon with data that mirrors the REAL v1 revenue shape, verified against live Stripe
// on 2026-07-26. Deliberately not richer than reality: the point of the vertical slice is to
// prove the schema answers Keoni's question correctly, and inventing extra volume would
// dilute that. `scripts/etl/verify.ts` reconciles against these same totals, so seed -> verify
// exercises the whole chain before any real import.
//
// Run: npx tsx scripts/seed.ts

import { sql } from 'drizzle-orm'

import { db } from './db'
import * as s from '@/lib/db/schema'

// Fixed ids so re-seeding is deterministic and rows are easy to reference by eye.
const KEONI = '00000000-0000-4000-8000-000000000001'
const P_LEYLA = '00000000-0000-4000-8000-000000000002'
const P_KARLY = '00000000-0000-4000-8000-000000000003'
const P_KATY = '00000000-0000-4000-8000-000000000004'
const P_NICHOLE = '00000000-0000-4000-8000-000000000005'

const SVC_LASER = '00000000-0000-4000-8000-000000000101'
const SVC_TATTOO = '00000000-0000-4000-8000-000000000102'
const PS_LEYLA_LASER = '00000000-0000-4000-8000-000000000201'
const PS_KARLY_TATTOO = '00000000-0000-4000-8000-000000000202'

const CLIENT_A = '00000000-0000-4000-8000-000000000301'
const CLIENT_B = '00000000-0000-4000-8000-000000000302'
const BOOKING_A = '00000000-0000-4000-8000-000000000401'
const BOOKING_B = '00000000-0000-4000-8000-000000000402'
const ROOM_BOOKING = '00000000-0000-4000-8000-000000000501'
const ENROLLMENT = '00000000-0000-4000-8000-000000000601'
const COURSE = '00000000-0000-4000-8000-000000000602'

const d = (iso: string) => new Date(iso)

async function main() {
  // Truncate in FK-safe order. RESTART IDENTITY is harmless here (all uuid PKs) but keeps
  // this correct if a serial column is ever added.
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

  await db.insert(s.providers).values([
    {
      id: KEONI, email: 'keoni@melanitesuite.com', firstName: 'Keoni', lastName: 'Ramos',
      role: 'platform_owner', status: 'active', bookingEnabled: false,
      requiresPasswordReset: true, joinedAt: d('2026-05-13T00:00:00Z'),
    },
    {
      id: P_LEYLA, email: 'leyla@example.com', firstName: 'Leyla', lastName: 'K',
      role: 'provider', status: 'active', bookingEnabled: true,
      medicalDirectorType: 'melanite', medicalDirectorStatus: 'active',
      stripeOnboardingComplete: true, requiresPasswordReset: true,
      joinedAt: d('2026-07-13T00:00:00Z'),
    },
    {
      id: P_KARLY, email: 'karly@example.com', firstName: 'Karly', lastName: 'D',
      role: 'provider', status: 'active', bookingEnabled: true,
      medicalDirectorType: 'melanite', medicalDirectorStatus: 'active',
      stripeOnboardingComplete: true, requiresPasswordReset: true,
      joinedAt: d('2026-07-18T00:00:00Z'),
    },
    {
      id: P_KATY, email: 'katy@example.com', firstName: 'Katy', lastName: 'N',
      role: 'provider', status: 'active', medicalDirectorType: 'melanite',
      medicalDirectorStatus: 'active', requiresPasswordReset: true,
      joinedAt: d('2026-07-14T00:00:00Z'),
    },
    {
      id: P_NICHOLE, email: 'nichole@example.com', firstName: 'Nichole', lastName: 'M',
      role: 'provider', status: 'active', medicalDirectorType: 'melanite',
      medicalDirectorStatus: 'active', requiresPasswordReset: true,
      joinedAt: d('2026-07-21T00:00:00Z'),
    },
  ])

  await db.insert(s.platformSettings).values({
    id: 1, stripePlatformAccountId: 'acct_1TaH1LCP9MreAgWj',
    providerSharePct: '0.500', packagesEnabled: false, roomRentalEnabled: true,
  })

  await db.insert(s.services).values([
    {
      id: SVC_LASER, name: 'Laser Hair Removal', suggestedDurationMins: 30,
      minDurationMins: 15, maxDurationMins: 60, packageEligible: true, colorHex: '#B8965A',
    },
    {
      id: SVC_TATTOO, name: 'Tattoo Removal', suggestedDurationMins: 45,
      minDurationMins: 30, maxDurationMins: 90, packageEligible: true, colorHex: '#5a8ec7',
    },
  ])

  await db.insert(s.providerServices).values([
    { id: PS_LEYLA_LASER, providerId: P_LEYLA, serviceId: SVC_LASER, price: '125.00', durationMins: 30 },
    { id: PS_KARLY_TATTOO, providerId: P_KARLY, serviceId: SVC_TATTOO, price: '17.25', durationMins: 45 },
  ])

  await db.insert(s.clients).values([
    { id: CLIENT_A, name: 'Client A', email: 'client.a@example.com', phone: '+12085550101', createdAt: d('2026-07-16T00:00:00Z') },
    { id: CLIENT_B, name: 'Client B', email: 'client.b@example.com', phone: '+12085550102', createdAt: d('2026-07-06T00:00:00Z') },
  ])

  await db.insert(s.bookings).values([
    {
      id: BOOKING_A, providerId: P_LEYLA, providerServiceId: PS_LEYLA_LASER, clientId: CLIENT_A,
      clientName: 'Client A', clientEmail: 'client.a@example.com', clientPhone: '+12085550101',
      originalPrice: '125.00', price: '125.00', paymentSource: 'checkout_link',
      durationMins: 30, status: 'completed',
      createdAt: d('2026-07-16T10:00:00Z'),
      startTime: d('2026-07-18T16:00:00Z'), endTime: d('2026-07-18T16:30:00Z'),
    },
    {
      id: BOOKING_B, providerId: P_KARLY, providerServiceId: PS_KARLY_TATTOO, clientId: CLIENT_B,
      clientName: 'Client B', clientEmail: 'client.b@example.com', clientPhone: '+12085550102',
      originalPrice: '17.25', price: '17.25', paymentSource: 'checkout_link',
      durationMins: 45, status: 'cancelled',
      createdAt: d('2026-07-06T09:00:00Z'),
      startTime: d('2026-07-08T15:00:00Z'), endTime: d('2026-07-08T15:45:00Z'),
    },
  ])

  await db.insert(s.roomBookings).values({
    id: ROOM_BOOKING, providerId: P_LEYLA, rentalDate: '2026-07-15', slotType: 'pm',
    price: '60.00', status: 'refunded',
    createdAt: d('2026-07-13T00:00:00Z'),
    startAt: d('2026-07-15T19:00:00Z'), endAt: d('2026-07-16T02:00:00Z'),
  })

  await db.insert(s.trainingCourses).values({
    id: COURSE, day1Date: '2026-07-19', day2Date: '2026-07-20', status: 'completed',
    depositAmount: '500.00', totalPrice: '1400.00', createdAt: d('2026-07-01T00:00:00Z'),
  })

  await db.insert(s.trainingEnrollments).values({
    id: ENROLLMENT, trainingCourseId: COURSE, providerId: null,
    firstName: 'Eva', lastName: 'Z', email: 'eva@example.com',
    paymentStatus: 'paid_in_full', createdAt: d('2026-07-09T00:00:00Z'),
  })

  const memberships = [P_LEYLA, P_KARLY, P_KATY, P_NICHOLE].map((providerId, i) => ({
    providerId, plan: 'medical_director' as const, status: 'active' as const,
    startDate: d(`2026-07-${13 + i * 2}T00:00:00Z`),
    createdAt: d(`2026-07-${13 + i * 2}T00:00:00Z`),
  }))
  const insertedMemberships = await db.insert(s.memberships).values(memberships).returning({ id: s.memberships.id, providerId: s.memberships.providerId })

  // ---- the ledger ----
  // Mirrors the five real revenue streams. See scripts/etl/README.md for the derivation.
  await db.insert(s.ledgerEntries).values([
    // Bookings — client pays, split 50/50, tip goes entirely to the provider.
    {
      source: 'booking', payer: 'client', entryType: 'purchase',
      subjectType: 'booking', subjectId: BOOKING_A,
      providerId: P_LEYLA, clientId: CLIENT_A, serviceId: SVC_LASER,
      grossAmount: '125.00', tipAmount: '25.00',
      providerPayout: '87.50', melaniteCut: '62.50',
      payoutStatus: 'paid', payoutDate: '2026-07-21',
      createdAt: d('2026-07-16T10:05:00Z'),
    },
    {
      source: 'booking', payer: 'client', entryType: 'purchase',
      subjectType: 'booking', subjectId: BOOKING_B,
      providerId: P_KARLY, clientId: CLIENT_B, serviceId: SVC_TATTOO,
      grossAmount: '17.25', tipAmount: '0.00',
      providerPayout: '9.75', melaniteCut: '7.50',
      payoutStatus: 'paid',
      createdAt: d('2026-07-06T09:05:00Z'),
    },
    // The refund v1 never recorded. transfer_reversal was null, so the provider kept their
    // $9.75 and the platform absorbed the whole $17.25 — payout 0, cut fully negative.
    {
      source: 'booking', payer: 'client', entryType: 'refund',
      subjectType: 'booking', subjectId: BOOKING_B,
      providerId: P_KARLY, clientId: CLIENT_B, serviceId: SVC_TATTOO,
      grossAmount: '-17.25', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '-17.25',
      payoutStatus: 'paid',
      createdAt: d('2026-07-06T12:00:00Z'),
      note: 'Reconstructed from Stripe — v1 recorded no booking refunds.',
    },

    // Memberships — provider pays Melanite. Unsplit: cut == gross, payout 0.
    ...insertedMemberships.map((m, i) => ({
      source: 'membership' as const, payer: 'provider' as const, entryType: 'purchase' as const,
      subjectType: 'membership' as const, subjectId: m.id,
      providerId: m.providerId,
      grossAmount: '150.00', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '150.00',
      payoutStatus: 'paid' as const,
      createdAt: d(`2026-07-${13 + i * 2}T12:00:00Z`),
    })),

    // Room rental — provider pays, then fully refunded. Nets to zero.
    {
      source: 'room_rental', payer: 'provider', entryType: 'purchase',
      subjectType: 'room_booking', subjectId: ROOM_BOOKING, providerId: P_LEYLA,
      grossAmount: '60.00', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '60.00',
      payoutStatus: 'paid', createdAt: d('2026-07-13T18:00:00Z'),
    },
    {
      source: 'room_rental', payer: 'provider', entryType: 'refund',
      subjectType: 'room_booking', subjectId: ROOM_BOOKING, providerId: P_LEYLA,
      grossAmount: '-60.00', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '-60.00',
      payoutStatus: 'paid', createdAt: d('2026-07-13T18:30:00Z'),
    },

    // Training — the student is not a provider yet, so providerId is null.
    {
      source: 'training', payer: 'student', entryType: 'purchase',
      subjectType: 'training_enrollment', subjectId: ENROLLMENT, providerId: null,
      grossAmount: '500.00', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '500.00',
      payoutStatus: 'paid', createdAt: d('2026-07-09T15:00:00Z'),
      note: 'Deposit',
    },
    {
      source: 'training', payer: 'student', entryType: 'purchase',
      subjectType: 'training_enrollment', subjectId: ENROLLMENT, providerId: null,
      grossAmount: '900.00', tipAmount: '0.00',
      providerPayout: '0.00', melaniteCut: '900.00',
      payoutStatus: 'paid', createdAt: d('2026-07-19T14:00:00Z'),
      note: 'Balance',
    },
  ])

  console.log('seeded — expect platform revenue $2,052.75 across 5 sources')
  console.log('verify with: npx tsx scripts/etl/verify.ts')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
