'use server'

import { randomBytes } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { bookingHasPayment, getProviderSharePct } from '@/lib/db/queries/admin-tools'
import { INVITE_TTL_DAYS, providerExists } from '@/lib/db/queries/invites'
import { splitClientPayment, toCents, toMoney } from '@/lib/money'
import { denverInstant, getLaserHours } from '@/lib/db/queries/availability'
import {
  bookings,
  clients,
  inviteLinks,
  ledgerEntries,
  memberships,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'
import { providerInviteEmail, sendEmail } from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

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

/** Invite a provider.
 *
 *  The only route into the system — there is no self-service signup, and there should not be:
 *  a provider is someone Keoni has met, usually at a training course. The `invite_links` table
 *  has existed since the first migration with nothing driving it; this is what drives it.
 */
export async function inviteProvider(email: string): Promise<ToolState & { url?: string }> {
  const admin = await requireAdmin()
  const address = email.trim().toLowerCase()

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { error: 'Enter a valid email address.' }
  }

  if (await providerExists(address)) {
    // Inviting someone who already has an account would create a token that can never be
    // accepted — the acceptance path refuses to make a second provider for one email.
    return { error: 'Someone already has an account with that email.' }
  }

  // Any outstanding invite for this address is superseded. Two live tokens for one person means
  // whichever they happen to click decides their account, and the other lingers as a loose
  // credential.
  await db
    .update(inviteLinks)
    .set({ status: 'expired' })
    .where(and(eq(inviteLinks.email, address), eq(inviteLinks.status, 'pending')))

  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db.insert(inviteLinks).values({
    email: address,
    invitedByAdminId: admin.id,
    token,
    status: 'pending',
    expiresAt,
  })

  const url = `${await appOrigin()}/onboard/${token}`

  const sent = await sendEmail({
    to: address,
    ...providerInviteEmail({
      invitedBy: `${admin.firstName} ${admin.lastName}`,
      url,
      expiresInDays: INVITE_TTL_DAYS,
    }),
  })

  revalidatePath('/app/admin/tools')

  // The invite exists either way — say which happened rather than collapsing "no key
  // configured" and "the address was rejected" into one vague sentence.
  return {
    success: sent.delivered
      ? `Invite emailed to ${address}. It expires in ${INVITE_TTL_DAYS} days.`
      : sent.reason === 'not-configured'
        ? `Invite created for ${address}. Email isn't set up yet, so send this link yourself.`
        : `Invite created, but the email didn't send — ${sent.detail}. Send this link yourself.`,
    url,
  }
}

/** Reads back the link for an invite that already exists.
 *
 *  Fetched on demand rather than listed with the invites, deliberately. A token is a bearer
 *  credential — whoever holds it can create that provider's account — so shipping every
 *  outstanding one to the browser on every page load, into a tab that may sit open on a desk
 *  all day, costs more than it saves. This crosses the wire when an admin asks for it.
 *
 *  Without this the link was recoverable exactly once, in the response to creating it. If the
 *  email did not send and the admin reloaded the page, the only way back was revoke-and-reinvite
 *  — and the provider then holds two links, one of which silently no longer works.
 */
export async function inviteUrl(inviteId: string): Promise<ToolState & { url?: string }> {
  await requireAdmin()

  const [invite] = await db
    .select({
      token: inviteLinks.token,
      status: inviteLinks.status,
      expiresAt: inviteLinks.expiresAt,
    })
    .from(inviteLinks)
    .where(eq(inviteLinks.id, inviteId))
    .limit(1)

  if (!invite) return { error: 'That invite does not exist.' }
  if (invite.status !== 'pending') {
    // Handing out a dead link is worse than refusing: it gets sent, and the provider hits a
    // wall with no idea why.
    return { error: 'That invite is no longer live, so its link would not work.' }
  }
  if (invite.expiresAt < new Date()) {
    return { error: 'That invite has expired. Revoke it and send a new one.' }
  }

  return { url: `${await appOrigin()}/onboard/${invite.token}` }
}

/** Sends the same invite again, to the same address.
 *
 *  The same token, not a new one. "I never got the email" is the common case and it does not
 *  mean the link is compromised — minting a fresh token would quietly kill the first one, so
 *  anyone who did eventually find the original email would then be told their invite is
 *  invalid. The deadline is not extended either: the seven days started when it was sent, and
 *  moving that would make the expiry a fiction. A genuinely stale invite gets revoked and
 *  reissued, which is a different button.
 */
export async function resendInvite(inviteId: string): Promise<ToolState & { url?: string }> {
  const admin = await requireAdmin()

  const [invite] = await db
    .select({
      email: inviteLinks.email,
      token: inviteLinks.token,
      status: inviteLinks.status,
      expiresAt: inviteLinks.expiresAt,
    })
    .from(inviteLinks)
    .where(eq(inviteLinks.id, inviteId))
    .limit(1)

  if (!invite) return { error: 'That invite does not exist.' }
  if (invite.status === 'accepted') {
    return { error: 'That invite has already been accepted — the account exists.' }
  }
  if (invite.status !== 'pending' || invite.expiresAt < new Date()) {
    return { error: 'That invite is no longer live. Revoke it and send a new one.' }
  }

  const url = `${await appOrigin()}/onboard/${invite.token}`
  const daysLeft = Math.max(
    1,
    Math.ceil((invite.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  )

  const sent = await sendEmail({
    to: invite.email,
    ...providerInviteEmail({
      invitedBy: `${admin.firstName} ${admin.lastName}`,
      url,
      // What is actually left, not the full seven days — the original clock is still running.
      expiresInDays: daysLeft,
    }),
  })

  if (!sent.delivered) {
    return {
      error:
        sent.reason === 'not-configured'
          ? 'Email is not set up yet. Copy the link and send it yourself.'
          : `The email didn’t send — ${sent.detail}. Copy the link and send it yourself.`,
      url,
    }
  }

  return {
    success: `Invite re-sent to ${invite.email}. It still expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
  }
}

/** Revokes an outstanding invite. */
export async function revokeInvite(inviteId: string): Promise<ToolState> {
  await requireAdmin()

  const [invite] = await db
    .select({ id: inviteLinks.id, status: inviteLinks.status })
    .from(inviteLinks)
    .where(eq(inviteLinks.id, inviteId))
    .limit(1)

  if (!invite) return { error: 'That invite does not exist.' }
  if (invite.status === 'accepted') {
    // The account already exists; revoking the invite now would achieve nothing except making
    // the list lie about what happened.
    return { error: 'That invite has already been accepted. Deactivate the provider instead.' }
  }

  await db.update(inviteLinks).set({ status: 'expired' }).where(eq(inviteLinks.id, invite.id))

  revalidatePath('/app/admin/tools')
  return { success: 'Invite revoked. The link no longer works.' }
}
