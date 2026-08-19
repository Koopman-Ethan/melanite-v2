'use server'

import { randomBytes } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { bookingBlockedReasons, canBook, requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { isExclusionViolation } from '@/lib/db/errors'
import {
  denverInstant,
  getLaserHours,
  overlapsTrainingCourse,
} from '@/lib/db/queries/availability'
import { getSpendableBalances } from '@/lib/db/queries/prepaid'
import {
  clients,
  prepaidBalances,
  prepaidCheckoutLinks,
  prepaidRedemptions,
  providerServices,
  services,
} from '@/lib/db/schema'
import {
  appointmentWhen,
  bookingConfirmedEmail,
  bookingPaymentLinkEmail,
  sendEmail,
} from '@/lib/email'
import { toCents, toMoney } from '@/lib/money'
import { notifyMelaniteBooked } from '@/lib/notify-melanite'
import { appOrigin } from '@/lib/stripe/config'
import { isValidEmail } from '@/lib/validation'

/** Same fourteen days a package link gets, and for the same reason: a prepaid balance is a
 *  decision about a few hundred dollars, not a formality, and these often go to a relative
 *  buying a gift who will not act on it the same afternoon. */
const PREPAID_LINK_TTL_DAYS = 14
const CHECKOUT_LINK_TTL_DAYS = 7

export interface PrepaidState {
  error?: string
  success?: string
}

/** Finds the client this balance is FOR, creating the row if the provider typed a new one.
 *
 *  Resolved when the link is created rather than when it is paid — the opposite of the package
 *  flow, and deliberately. A gift is paid for by somebody who is not the beneficiary, so
 *  deriving the client from the payment would put the balance on the wrong person's record.
 *  Keoni's words were "link their payment under a specific client", and this is that. */
async function resolveClient(input: {
  clientId?: string | null
  clientName?: string | null
  clientEmail?: string | null
  clientPhone?: string | null
}): Promise<{ id: string } | { error: string }> {
  if (input.clientId) {
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, input.clientId))
      .limit(1)

    if (!existing) return { error: 'That client no longer exists.' }
    return existing
  }

  const name = input.clientName?.trim()
  const email = input.clientEmail?.trim().toLowerCase()

  if (!name) return { error: 'Who is this balance for? Enter a name.' }
  if (!email) return { error: 'An email is needed so the balance can be traced to a person.' }
  if (!isValidEmail(email)) return { error: 'That email does not look right.' }

  const [existing] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.email, email))
    .limit(1)

  if (existing) return existing

  const [created] = await db
    .insert(clients)
    .values({ name, email, phone: input.clientPhone?.trim() || null })
    .returning({ id: clients.id })

  return created
}

/** Sell a prepaid balance: creates the link the client, or whoever is buying it for them, pays. */
export async function createPrepaidLink(input: {
  amount: number
  clientId?: string | null
  clientName?: string | null
  clientEmail?: string | null
  clientPhone?: string | null
  purchaserName?: string | null
  purchaserEmail?: string | null
}): Promise<PrepaidState & { url?: string }> {
  const user = await requireProvider()

  // Money that is not a number, is negative, or carries fractional cents is not a balance.
  // Rounding it silently is how somebody's 200.005 becomes a figure they never typed.
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { error: 'Enter an amount greater than zero.' }
  }
  if (Math.round(input.amount * 100) !== input.amount * 100) {
    return { error: 'Amounts cannot be smaller than a cent.' }
  }

  const client = await resolveClient(input)
  if ('error' in client) return { error: client.error }

  const purchaserEmail = input.purchaserEmail?.trim().toLowerCase() || null
  if (purchaserEmail && !isValidEmail(purchaserEmail)) {
    return { error: 'That purchaser email does not look right.' }
  }

  // Supersede any outstanding link for the same client and provider. Two live links means
  // whichever they happen to open decides the amount, and the other sits there as a second
  // chance to be charged — the same rule provider invites follow.
  await db
    .update(prepaidCheckoutLinks)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(prepaidCheckoutLinks.providerId, user.id),
        eq(prepaidCheckoutLinks.clientId, client.id),
        eq(prepaidCheckoutLinks.status, 'pending'),
      ),
    )

  const token = randomBytes(24).toString('base64url')

  const [link] = await db
    .insert(prepaidCheckoutLinks)
    .values({
      token,
      providerId: user.id,
      clientId: client.id,
      amount: input.amount.toFixed(2),
      purchaserName: input.purchaserName?.trim() || null,
      purchaserEmail,
      expiresAt: new Date(Date.now() + PREPAID_LINK_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning({ token: prepaidCheckoutLinks.token })

  const url = `${await appOrigin()}/pay/prepaid/${link.token}`

  revalidatePath('/app/prepaid')

  return {
    success: `Link created for $${input.amount.toFixed(2)}. Copy it to whoever is paying.`,
    url,
  }
}

/** Book an appointment paid from a client's prepaid balance.
 *
 *  Structured as `bookFromPackage`, with the two differences that make it about money rather
 *  than sessions:
 *
 *   - The claim is an AMOUNT, taken oldest balance first, and may span several balances. A $220
 *     service against $50 and $200 draws $50 then $170.
 *   - A balance that does not cover the service leaves a remainder, and the remainder gets an
 *     ordinary checkout link. That money is new money and splits at payment the way any booking
 *     does; the prepaid part was already split when it was bought.
 *
 *  Like a package redemption this is NOT gated on any feature flag. Value already paid for must
 *  stay redeemable whatever gets switched off later.
 */
export async function bookFromPrepaid(input: {
  clientId: string
  providerServiceId: string
  startTime: string
  treatmentArea?: string | null
  notes?: string | null
}): Promise<PrepaidState & { bookingId?: string; url?: string; due?: string }> {
  const user = await requireProvider()

  if (!canBook(user)) {
    const gates = bookingBlockedReasons(user)
    return { error: gates.map((g) => g.message).join(' ') || 'Your account cannot book.' }
  }

  const [client] = await db
    .select({ id: clients.id, name: clients.name, email: clients.email, phone: clients.phone })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1)

  if (!client) return { error: 'That client does not exist.' }

  const [svc] = await db
    .select({
      durationMins: providerServices.durationMins,
      price: providerServices.price,
      name: services.name,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.id, input.providerServiceId),
        eq(providerServices.providerId, user.id),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )
    .limit(1)

  if (!svc) return { error: 'That service is not available on your profile.' }

  const priceCents = toCents(svc.price)
  if (priceCents <= 0) return { error: 'That service has no price set.' }

  const startTime = new Date(input.startTime)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }
  if (startTime <= new Date()) return { error: 'Choose a time in the future.' }

  const endTime = new Date(startTime.getTime() + svc.durationMins * 60_000)

  const hours = await getLaserHours()
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(startTime)
  if (
    startTime < denverInstant(day, hours.openTime) ||
    endTime > denverInstant(day, hours.closeTime)
  ) {
    return { error: 'That time is outside laser operating hours.' }
  }

  const spendable = await getSpendableBalances(user.id, client.id)
  if (spendable.length === 0) {
    return { error: `${client.name ?? 'That client'} has no prepaid balance left to book from.` }
  }

  // Everything above this line can fail without costing anybody money. The claims start here,
  // for the same reason `bookFromPackage` claims late: a provider mistyping a time must not
  // spend a client's balance.
  const claims: Array<{ balanceId: string; cents: number }> = []

  /** Puts every claimed amount back. Used on any failure after the first claim. */
  const release = async () => {
    for (const claim of claims) {
      await db
        .update(prepaidBalances)
        .set({
          remainingAmount: sql`${prepaidBalances.remainingAmount} + ${toMoney(claim.cents)}::numeric`,
          // A balance emptied by this booking was flipped to exhausted; returning the money
          // has to make it spendable again or the client silently loses it.
          status: 'active',
        })
        .where(eq(prepaidBalances.id, claim.balanceId))
    }
  }

  let outstanding = priceCents
  for (const balance of spendable) {
    if (outstanding <= 0) break

    const take = Math.min(toCents(balance.remainingAmount), outstanding)
    if (take <= 0) continue

    // The claim. Conditional on the money still being there, so a concurrent booking for the
    // same client cannot spend the same dollar twice — the read above is a plan, this is the
    // decision.
    const claimed = await db
      .update(prepaidBalances)
      .set({
        remainingAmount: sql`${prepaidBalances.remainingAmount} - ${toMoney(take)}::numeric`,
      })
      .where(
        and(
          eq(prepaidBalances.id, balance.id),
          sql`${prepaidBalances.remainingAmount} >= ${toMoney(take)}::numeric`,
        ),
      )
      .returning({ id: prepaidBalances.id })

    // Lost the race for THIS balance. Carry on to the next rather than failing the booking —
    // the client's other money is still theirs.
    if (claimed.length === 0) continue

    claims.push({ balanceId: balance.id, cents: take })
    outstanding -= take
  }

  if (claims.length === 0) {
    return { error: 'That balance was just spent. Refresh and try again.' }
  }

  const bookingId = crypto.randomUUID()
  const token = randomBytes(24).toString('base64url')
  const linkExpiresAt = new Date(Date.now() + CHECKOUT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)
  const duePart = toMoney(outstanding)

  // Collision check fused to the insert, exactly as every other booking path does it. The
  // laser does not care how this one was paid for.
  let booked
  try {
    booked =
      outstanding > 0
        ? await db.execute(sql`
            WITH new_booking AS (
              INSERT INTO bookings
                (id, provider_id, provider_service_id, client_id, client_name, client_phone,
                 client_email, treatment_area, notes, original_price, price, payment_source,
                 duration_mins, start_time, end_time, status)
              SELECT ${bookingId}::uuid, ${user.id}::uuid, ${input.providerServiceId}::uuid,
                     ${client.id}::uuid, ${client.name ?? 'Client'}, ${client.phone},
                     ${client.email}, ${input.treatmentArea ?? null}, ${input.notes ?? null},
                     ${svc.price}::numeric, ${duePart}::numeric,
                     'prepaid'::booking_payment_source,
                     ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
                     ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
              WHERE NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.status IN ('upcoming', 'completed')
                  AND b.start_time < ${endTime.toISOString()}::timestamptz
                  AND b.end_time   > ${startTime.toISOString()}::timestamptz
              )
              AND NOT ${overlapsTrainingCourse(startTime.toISOString(), endTime.toISOString())}
              RETURNING id
            )
            INSERT INTO checkout_links (booking_id, token, status, expires_at)
            SELECT id, ${token}, 'pending'::checkout_link_status,
                   ${linkExpiresAt.toISOString()}::timestamptz
            FROM new_booking
            RETURNING booking_id
          `)
        : await db.execute(sql`
            INSERT INTO bookings
              (id, provider_id, provider_service_id, client_id, client_name, client_phone,
               client_email, treatment_area, notes, original_price, price, payment_source,
               duration_mins, start_time, end_time, status)
            SELECT ${bookingId}::uuid, ${user.id}::uuid, ${input.providerServiceId}::uuid,
                   ${client.id}::uuid, ${client.name ?? 'Client'}, ${client.phone},
                   ${client.email}, ${input.treatmentArea ?? null}, ${input.notes ?? null},
                   ${svc.price}::numeric, 0::numeric,
                   'prepaid'::booking_payment_source,
                   ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
                   ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
            WHERE NOT EXISTS (
              SELECT 1 FROM bookings b
              WHERE b.status IN ('upcoming', 'completed')
                AND b.start_time < ${endTime.toISOString()}::timestamptz
                AND b.end_time   > ${startTime.toISOString()}::timestamptz
            )
            AND NOT ${overlapsTrainingCourse(startTime.toISOString(), endTime.toISOString())}
            RETURNING id
          `)
  } catch (err) {
    await release()
    if (isExclusionViolation(err)) {
      return { error: 'Someone just booked that slot. Pick another time.' }
    }
    throw err
  }

  if ((booked.rows?.length ?? 0) === 0) {
    await release()
    return { error: 'Someone just booked that slot. Pick another time.' }
  }

  await db.insert(prepaidRedemptions).values(
    claims.map((claim) => ({
      prepaidBalanceId: claim.balanceId,
      bookingId,
      amountApplied: toMoney(claim.cents),
    })),
  )

  // Emptied balances are marked so they stop being offered. Conditioned on the row itself
  // rather than assumed from the claim — a concurrent void could have put money back between
  // the claim and here.
  for (const claim of claims) {
    await db
      .update(prepaidBalances)
      .set({ status: 'exhausted' })
      .where(
        and(
          eq(prepaidBalances.id, claim.balanceId),
          sql`${prepaidBalances.remainingAmount} <= 0`,
        ),
      )
  }

  const applied = claims.reduce((sum, claim) => sum + claim.cents, 0)

  // Melanite hears about it either way. One call covers both shapes above — with a remainder
  // still due and without — because what she is being told is that the laser is taken.
  await notifyMelaniteBooked(bookingId)

  // What the client hears depends on whether they still owe anything. Sending "your
  // appointment is confirmed" alongside a bill, or a payment link for zero, are both wrong.
  if (client.email) {
    try {
      if (outstanding > 0) {
        await sendEmail({
          to: client.email,
          ...bookingPaymentLinkEmail({
            clientName: client.name ?? 'there',
            providerName: `${user.firstName} ${user.lastName}`,
            serviceName: svc.name,
            when: appointmentWhen(startTime),
            amount: `$${duePart}`,
            url: `${await appOrigin()}/pay/${token}`,
          }),
        })
      } else {
        await sendEmail({
          to: client.email,
          ...bookingConfirmedEmail({
            clientName: client.name ?? 'there',
            providerName: `${user.firstName} ${user.lastName}`,
            serviceName: svc.name,
            when: appointmentWhen(startTime),
            // Nothing was charged today; the money was handed over when the balance was bought.
            amount: null,
            coveredBy: 'prepaid',
          }),
        })
      }
    } catch (err) {
      // A booking that happened must never be reported as failed because an email bounced.
      console.error('[email] prepaid booking notice failed', err)
    }
  }

  revalidatePath('/app/prepaid')
  revalidatePath('/app/appointments')

  return {
    success:
      outstanding > 0
        ? `Booked. $${toMoney(applied)} came off the balance, $${duePart} still to pay.`
        : `Booked. $${toMoney(applied)} came off the balance, nothing left to pay.`,
    bookingId,
    due: duePart,
    ...(outstanding > 0 ? { url: `${await appOrigin()}/pay/${token}` } : {}),
  }
}
