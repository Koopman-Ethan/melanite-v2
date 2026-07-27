'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { bookingHasPayment, getProviderSharePct } from '@/lib/db/queries/admin-tools'
import { splitClientPayment, toCents, toMoney } from '@/lib/money'
import { denverInstant, getLaserHours } from '@/lib/db/queries/availability'
import {
  bookings,
  clients,
  ledgerEntries,
  memberships,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'

export interface ToolState {
  error?: string
  success?: string
}

const MANUAL_METHODS = ['cherry', 'groupon', 'cash', 'check', 'other'] as const
type ManualMethod = (typeof MANUAL_METHODS)[number]

/** Record a payment that reached Melanite outside Stripe.
 *
 *  Covers Cherry financing, a Groupon voucher, cash, a cheque. The booking already exists;
 *  what was missing is any record of how it was paid — which is why a Cherry-funded
 *  appointment was indistinguishable from an unpaid one.
 *
 *  The split follows platform_settings by default, but is overridable: a Groupon voucher the
 *  provider sold directly is theirs entirely, and forcing the platform split on it would
 *  invent revenue Melanite never received.
 */
export async function recordBookingPayment(input: {
  bookingId: string
  method: ManualMethod
  grossAmount: number
  tipAmount: number
  externalReference: string | null
  providerPayoutOverride: number | null
  note: string | null
}): Promise<ToolState> {
  const admin = await requireAdmin()

  if (!MANUAL_METHODS.includes(input.method)) {
    return { error: 'Choose how the payment was made.' }
  }
  if (!Number.isFinite(input.grossAmount) || input.grossAmount <= 0) {
    return { error: 'Enter an amount greater than zero.' }
  }

  const [booking] = await db
    .select({
      id: bookings.id,
      providerId: bookings.providerId,
      clientId: bookings.clientId,
      providerServiceId: bookings.providerServiceId,
    })
    .from(bookings)
    .where(eq(bookings.id, input.bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment does not exist.' }

  // Refuses rather than adding a second entry. Double-recording a payment is the most likely
  // mistake here and the hardest to spot afterwards, because both rows look plausible.
  if (await bookingHasPayment(input.bookingId)) {
    return { error: 'This appointment already has a payment recorded. Check before adding another.' }
  }

  const [svc] = await db
    .select({ serviceId: providerServices.serviceId })
    .from(providerServices)
    .where(eq(providerServices.id, booking.providerServiceId))
    .limit(1)

  const share = await getProviderSharePct()
  const grossCents = toCents(input.grossAmount)
  const tipCents = toCents(Math.max(input.tipAmount, 0))

  // Default: the platform split, via the same function the webhook uses, so a Cherry booking
  // and a card booking are calculated identically and are genuinely comparable.
  const payoutCents =
    input.providerPayoutOverride !== null
      ? toCents(input.providerPayoutOverride)
      : splitClientPayment({ grossCents, tipCents, providerSharePct: share }).providerPayoutCents

  if (payoutCents > grossCents + tipCents) {
    return { error: 'The provider payout cannot exceed what was collected.' }
  }

  const cutCents = grossCents + tipCents - payoutCents

  await db.insert(ledgerEntries).values({
    source: 'booking',
    payer: 'client',
    entryType: 'purchase',
    subjectType: 'booking',
    subjectId: booking.id,
    providerId: booking.providerId,
    clientId: booking.clientId,
    serviceId: svc?.serviceId ?? null,
    grossAmount: toMoney(grossCents),
    tipAmount: toMoney(tipCents),
    providerPayout: toMoney(payoutCents),
    melaniteCut: toMoney(cutCents),
    paymentMethod: input.method,
    externalReference: input.externalReference?.trim() || null,
    // Stripe Connect cannot pay out money it never received, so a manual payment implies a
    // manual settlement. Left pending so it shows up in what the provider is owed.
    payoutStatus: 'pending',
    payoutMethod: 'other',
    note: input.note?.trim() || null,
    recordedBy: admin.id,
  })

  revalidatePath('/app/admin/tools')
  revalidatePath('/app/admin/revenue')
  return { success: 'Payment recorded.' }
}

/** Record medical-director months paid straight to Keoni.
 *
 *  Providers sometimes hand over several months at once, outside Stripe entirely. Without
 *  this the money is invisible and — worse — their booking gate stays shut despite having
 *  paid.
 */
export async function recordMembershipPayment(input: {
  providerId: string
  amount: number
  months: number
  method: ManualMethod
  note: string | null
  activateGate: boolean
}): Promise<ToolState> {
  const admin = await requireAdmin()

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { error: 'Enter an amount greater than zero.' }
  }
  if (!Number.isInteger(input.months) || input.months < 1) {
    return { error: 'Enter how many months this covers.' }
  }

  const [provider] = await db
    .select({ id: providers.id, firstName: providers.firstName })
    .from(providers)
    .where(eq(providers.id, input.providerId))
    .limit(1)

  if (!provider) return { error: 'That provider does not exist.' }

  const [membership] = await db
    .select({ id: memberships.id, renewalDate: memberships.renewalDate })
    .from(memberships)
    .where(eq(memberships.providerId, provider.id))
    .limit(1)

  // Extend from whichever is later: an existing renewal date, or today. Extending from a
  // renewal already in the past would grant less time than was paid for.
  const from =
    membership?.renewalDate && membership.renewalDate > new Date()
      ? membership.renewalDate
      : new Date()
  const renewalDate = new Date(from)
  renewalDate.setMonth(renewalDate.getMonth() + input.months)

  // The membership row is settled first so the ledger entry has a real membership to point at.
  // Writing the entry first left `subject_type = 'membership'` with a provider id in
  // `subject_id` whenever the provider had no membership yet — a polymorphic reference that
  // resolves to the wrong table.
  let membershipId = membership?.id
  if (membershipId) {
    await db
      .update(memberships)
      .set({ status: 'active', renewalDate })
      .where(eq(memberships.id, membershipId))
  } else {
    const [created] = await db
      .insert(memberships)
      .values({
        providerId: provider.id,
        plan: 'medical_director',
        status: 'active',
        startDate: new Date(),
        renewalDate,
      })
      .returning({ id: memberships.id })
    membershipId = created.id
  }

  const gross = toMoney(toCents(input.amount))

  // Membership is provider-paid and unsplit — the whole amount is Melanite's, same as a
  // Stripe-billed one. The check constraint enforces it regardless.
  await db.insert(ledgerEntries).values({
    source: 'membership',
    payer: 'provider',
    entryType: 'purchase',
    subjectType: 'membership',
    subjectId: membershipId,
    providerId: provider.id,
    grossAmount: gross,
    tipAmount: '0.00',
    providerPayout: '0.00',
    melaniteCut: gross,
    paymentMethod: input.method,
    payoutStatus: 'paid',
    note: input.note?.trim() || `${input.months} month(s) paid directly`,
    recordedBy: admin.id,
  })

  // Opening the gate is the point of recording this, but it is stated as a choice rather than
  // assumed — the money might be a back-payment for a period already served.
  if (input.activateGate) {
    await db
      .update(providers)
      .set({ medicalDirectorStatus: 'active' })
      .where(eq(providers.id, provider.id))
  }

  revalidatePath('/app/admin/tools')
  revalidatePath('/app/admin/revenue')
  return {
    success: `Recorded ${input.months} month(s) for ${provider.firstName}, covered through ${renewalDate.toISOString().slice(0, 10)}.`,
  }
}

/** Create an appointment on a provider's behalf.
 *
 *  The provider gates are deliberately NOT applied: an admin entering an appointment that
 *  already happened should not be blocked because the provider's licence lapsed afterwards.
 *  The global collision check IS applied — the laser cannot be double-booked whoever is doing
 *  the booking.
 */
export async function createManualBooking(input: {
  providerId: string
  providerServiceId: string
  clientName: string
  clientPhone: string | null
  clientEmail: string | null
  /** `YYYY-MM-DD` and `HH:MM`, both Denver wall-clock. Kept as two fields rather than one
   *  `datetime-local` value because that input reports the *browser's* local time, which
   *  silently shifts every appointment an admin enters from another timezone. */
  date: string
  time: string
  price: number
  paymentSource: 'checkout_link' | 'comped'
  note: string | null
}): Promise<ToolState> {
  await requireAdmin()

  if (!input.clientName.trim()) return { error: 'Enter the client’s name.' }
  if (!Number.isFinite(input.price) || input.price < 0) return { error: 'Enter a valid price.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) {
    return { error: 'Pick a date and time.' }
  }

  const startTime = denverInstant(input.date, input.time)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }

  const [svc] = await db
    .select({ durationMins: providerServices.durationMins, price: providerServices.price })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.id, input.providerServiceId),
        eq(providerServices.providerId, input.providerId),
      ),
    )
    .limit(1)

  if (!svc) return { error: 'That service does not belong to that provider.' }

  const endTime = new Date(startTime.getTime() + svc.durationMins * 60_000)

  // Operating hours are a warning, not a bar — a manual entry is often recording something
  // that genuinely happened outside normal hours.
  const hours = await getLaserHours()
  const outsideHours =
    startTime < denverInstant(input.date, hours.openTime) ||
    endTime > denverInstant(input.date, hours.closeTime)

  // Past appointments land as completed; future ones as upcoming. Entering a past appointment
  // as "upcoming" is how stale rows accumulate.
  const status = startTime < new Date() ? 'completed' : 'upcoming'

  let clientId: string | null = null
  if (input.clientEmail?.trim()) {
    const email = input.clientEmail.trim().toLowerCase()
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.email, email))
      .limit(1)

    if (existing) clientId = existing.id
    else {
      const [created] = await db
        .insert(clients)
        .values({ email, name: input.clientName.trim(), phone: input.clientPhone })
        .returning({ id: clients.id })
      clientId = created.id
    }
  }

  const bookingId = crypto.randomUUID()

  const inserted = await db.execute(sql`
    INSERT INTO bookings
      (id, provider_id, provider_service_id, client_id, client_name, client_phone, client_email,
       notes, original_price, discount_type, discount_value, price, payment_source,
       duration_mins, start_time, end_time, status)
    SELECT ${bookingId}::uuid, ${input.providerId}::uuid, ${input.providerServiceId}::uuid,
           ${clientId}, ${input.clientName.trim()}, ${input.clientPhone}, ${input.clientEmail},
           ${input.note}, ${svc.price}::numeric, 'none'::discount_type, 0::numeric,
           ${toMoney(toCents(input.price))}::numeric, ${input.paymentSource}::booking_payment_source,
           ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
           ${endTime.toISOString()}::timestamptz, ${status}::booking_status
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.status IN ('upcoming', 'completed')
        AND b.start_time < ${endTime.toISOString()}::timestamptz
        AND b.end_time   > ${startTime.toISOString()}::timestamptz
    )
    RETURNING id
  `)

  if ((inserted.rows?.length ?? 0) === 0) {
    return { error: 'The laser is already booked for that time. Pick another slot.' }
  }

  revalidatePath('/app/admin/tools')
  revalidatePath('/app/appointments')
  return {
    success: outsideHours
      ? `Appointment created as ${status} — note it falls outside laser hours.`
      : `Appointment created as ${status}.`,
  }
}
