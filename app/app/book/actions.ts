'use server'

import { and, eq, sql } from 'drizzle-orm'
import { redirect } from 'next/navigation'

import { canBook, bookingBlockedReasons, requireProvider } from '@/lib/auth/dal'
import {
  denverInstant,
  getLaserHours,
  overlapsBlockedTime,
  overlapsTrainingCourse,
} from '@/lib/db/queries/availability'
import { db } from '@/lib/db'
import { isExclusionViolation } from '@/lib/db/errors'
import { bookings, providerServices, providers, services } from '@/lib/db/schema'
import { notifyMelaniteBooked, notifyProviderCharged } from '@/lib/notify-melanite'
import { chargeRentalFee } from '@/lib/rental/charge'
import {
  claimPackSession,
  recordPackRedemption,
  releasePackSession,
  type PackClaim,
} from '@/lib/rental/packs'
import { hasAcceptedRentalTerms } from '@/lib/rental-terms'
import { feeForService, liveScheduleVersion } from '@/lib/rental/schedule'
import { paysRent, sharesRevenue } from '@/lib/revenue-model'

export interface BookState {
  error?: string
}

/** Reserve the laser, and pay Melanite rent for it.
 *
 *  Under the rental model this app does not know who the client is, what they are being charged,
 *  or whether they have paid. The provider runs their own business; Melanite rents out one
 *  machine. So the booking carries a provider, a service and a block of time, and the only money
 *  in it is the rental fee — charged to the provider, by Melanite, immediately.
 *
 *  THE ORDER HERE IS THE DESIGN. Two things can fail and they must fail in this order:
 *
 *    1. The slot. One laser, one appointment — `bookings_no_overlap` is the guarantee and it can
 *       only arbitrate once a row exists. So the slot is claimed FIRST.
 *    2. The card. Ethan's rule is that a declined card fails the booking, so the charge follows
 *       immediately and the booking is deleted if it does not go through.
 *
 *  Charging before inserting would invert both: money taken for a slot somebody else won a
 *  millisecond earlier, then refunded. Taking the slot first means the only cost of a decline is
 *  a row that existed for a few hundred milliseconds.
 *
 *  The window this leaves is a crash between the insert and the charge, which would leave an
 *  appointment nobody was billed for. That cannot be closed without a transaction the driver does
 *  not have, so it is detected instead — `unchargedRentalBookings()` in `lib/rental/charge.ts`
 *  finds them, and re-running the charge is safe because the Stripe idempotency key is the
 *  booking's own id.
 */
export async function createBooking(_prev: BookState, formData: FormData): Promise<BookState> {
  const user = await requireProvider()

  // Gates first. canBook() covers bookingEnabled, medicalDirectorStatus and license expiry;
  // an inactive account never gets a session at all.
  if (!canBook(user)) {
    const gates = bookingBlockedReasons(user)
    return {
      error: gates.length ? gates.map((g) => g.message).join(' ') : 'Your account cannot book right now.',
    }
  }

  const serviceId = String(formData.get('serviceId') ?? '')
  const requestedMins = Number(formData.get('durationMins') ?? 0)
  const startTimeRaw = String(formData.get('startTime') ?? '')
  const treatmentArea = String(formData.get('treatmentArea') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null

  if (!serviceId) return { error: 'Choose a service.' }
  if (!startTimeRaw) return { error: 'Choose a time.' }

  const startTime = new Date(startTimeRaw)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }
  if (startTime <= new Date()) return { error: 'Choose a time in the future.' }

  // The service only has to exist and still be offered. It no longer has to be one this
  // provider ticked in a setup form — every active service is bookable by everybody, because
  // the menu was a client-facing idea and Melanite no longer knows anybody's clients.
  const [svc] = await db
    .select({
      suggestedDurationMins: services.suggestedDurationMins,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      name: services.name,
    })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.active, true)))
    .limit(1)

  if (!svc) return { error: 'That service is not available.' }
  // Checked here and not only in the form. The duration decides how much of a shared laser is
  // taken, so a hand-edited request must not be able to claim four hours for a chin.
  const durationMins = Number.isInteger(requestedMins) && requestedMins > 0
    ? requestedMins
    : svc.suggestedDurationMins

  if (durationMins < svc.minDurationMins || durationMins > svc.maxDurationMins) {
    return {
      error: `${svc.name} has to be between ${svc.minDurationMins} and ${svc.maxDurationMins} minutes.`,
    }
  }

  const [provider] = await db
    .select({
      revenueModel: providers.revenueModel,
      customerId: providers.stripeBillingCustomerId,
      paymentMethodId: providers.billingPaymentMethodId,
      rentalTermsVersion: providers.rentalTermsVersion,
      rentalScheduleVersion: providers.rentalScheduleVersion,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  // Melanite treating Melanite's own client. There is no rent to pay yourself.
  //
  // `requireProvider()` above guarantees the row, so the `!provider` arm never fires. It is
  // written out rather than defaulted to false because the predicate this replaced treated a
  // missing row as PAYING rent, and a missing row that silently books for free is the wrong
  // direction to be wrong in.
  const payingRent = !provider || paysRent(provider.revenueModel)

  // A grandfathered 50/50 provider cannot use this path yet, and must not be let through it.
  //
  // Every gate below is written `payingRent && ...`, so for them all four are skipped: no fee
  // lookup, no card, no terms, no charge — and the INSERT further down hard-codes `rental` with
  // zero prices and no client. The result would be a free session on the shared laser, which is
  // the exact failure the error a few lines down exists to prevent, arrived at from the other
  // direction and without even a message.
  //
  // Their own path — client details, their own price, a checkout link, Melanite's half — is
  // restored in a later commit. Until then this refuses loudly instead of booking quietly.
  if (provider && sharesRevenue(provider.revenueModel)) {
    return {
      error:
        'Your account is on the 50/50 arrangement, and booking for it is being rebuilt. ' +
        'Tell Keoni rather than working around this — nothing would be charged if it went through.',
    }
  }

  const feeCents = await feeForService(svc.name)
  if (payingRent && feeCents === null) {
    // A service nobody has set a rental fee for. Refusing is the whole point: letting it through
    // would be a free session, and a free session is not discovered until the month's takings are
    // short. See UNPRICED in lib/rental-fees.ts for what each one is waiting on.
    return {
      error: `${svc.name} has no rental fee set yet, so it can’t be booked. Ask Keoni to price it.`,
    }
  }

  // Checked before the slot is taken rather than after. The charge checks this too, but finding
  // out here costs nobody an appointment that gets created and deleted.
  if (payingRent && (!provider?.customerId || !provider?.paymentMethodId)) {
    return {
      error: 'Add a card before booking — Melanite charges the rental fee when you reserve the laser.',
    }
  }

  // The rental terms say in as many words that a provider will be asked to accept a new fee
  // schedule before their next booking. This is what makes that true rather than aspirational —
  // a term the code does not implement is a term that quietly becomes false.
  if (payingRent && !hasAcceptedRentalTerms(provider, await liveScheduleVersion())) {
    return {
      error: 'The rental terms or prices have changed. Accept them before booking.',
    }
  }

  const endTime = new Date(startTime.getTime() + durationMins * 60_000)

  // Operating hours, evaluated on the booking's own date in Mountain Time.
  const hours = await getLaserHours()
  const dayInDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(startTime)
  const open = denverInstant(dayInDenver, hours.openTime)
  const close = denverInstant(dayInDenver, hours.closeTime)
  if (startTime < open || endTime > close) {
    return { error: 'That time is outside laser operating hours.' }
  }

  // `provider_services` is no longer a menu — it is where this provider's length for this
  // service is remembered, and `bookings.provider_service_id` is NOT NULL, so one has to exist.
  // Created on first use rather than in a setup form: the first booking is the first moment
  // there is anything true to record.
  //
  // Upserted every time, so changing the length today is what it defaults to next time. The
  // price column is written once at 0.00 and never read — it dies with the client-payment code.
  const [existingLink] = await db
    .select({ id: providerServices.id })
    .from(providerServices)
    .where(
      and(eq(providerServices.providerId, user.id), eq(providerServices.serviceId, serviceId)),
    )
    .limit(1)

  let providerServiceId: string
  if (existingLink) {
    providerServiceId = existingLink.id
    await db
      .update(providerServices)
      .set({ durationMins, isActive: true })
      .where(eq(providerServices.id, existingLink.id))
  } else {
    const [created] = await db
      .insert(providerServices)
      .values({
        providerId: user.id,
        serviceId,
        price: '0.00',
        durationMins,
        isActive: true,
      })
      .returning({ id: providerServices.id })
    providerServiceId = created.id
  }

  const bookingId = crypto.randomUUID()

  // The pack session is claimed HERE, after every validation and immediately before the write.
  //
  // Claiming late matters as much as claiming atomically: every `return { error }` above is a
  // path where nothing was booked, and a session claimed before one of them is a session the
  // provider paid for and lost to a mistyped time. The same lesson as the client-package path,
  // which learned it the expensive way.
  let claim: PackClaim | null = null
  if (payingRent) {
    claim = await claimPackSession(user.id, svc.name)
  }

  /** Hands the claimed session back. Must run on every path between here and the redirect that
   *  does not end in a booking. */
  const releaseClaim = async () => {
    if (claim) await releasePackSession(claim)
  }

  // One statement. The NOT EXISTS is the FRIENDLY check, not the guarantee: under READ COMMITTED
  // two concurrent statements each evaluate it against a snapshot that cannot see the other's
  // uncommitted row, so both find the slot free and both insert. The real guarantee is the
  // `bookings_no_overlap` EXCLUDE constraint (migration 0013) — a violation there means somebody
  // won the race, not that anything is broken.
  //
  // No client columns and no price: `bookings_rental_has_no_client` and
  // `bookings_rental_has_no_price` make that a database guarantee rather than a habit of this
  // one function.
  let booked
  try {
    booked = await db.execute(sql`
      INSERT INTO bookings
        (id, provider_id, provider_service_id, treatment_area, notes,
         original_price, price, payment_source, duration_mins, start_time, end_time, status)
      SELECT ${bookingId}::uuid, ${user.id}::uuid, ${providerServiceId}::uuid,
             ${treatmentArea}, ${notes}, '0.00'::numeric, '0.00'::numeric,
             'rental'::booking_payment_source, ${durationMins},
             ${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz,
             'upcoming'::booking_status
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.status IN ('upcoming', 'completed')
          AND b.start_time < ${endTime.toISOString()}::timestamptz
          AND b.end_time   > ${startTime.toISOString()}::timestamptz
      )
      -- ...and not inside a training course. Same statement as the booking check on
      -- purpose: two separate reads could each pass against a different snapshot.
      AND NOT ${overlapsTrainingCourse(startTime.toISOString(), endTime.toISOString())}
      -- ...and not inside time Melanite has taken out of service. Same statement
      -- again, for the same reason.
      AND NOT ${overlapsBlockedTime(startTime.toISOString(), endTime.toISOString())}
      RETURNING id
    `)
  } catch (err) {
    await releaseClaim()
    // 23P01 — exclusion_violation. The other side of the race committed first, which is the
    // constraint doing exactly its job. Anything else is a real failure and should surface.
    if (isExclusionViolation(err)) {
      return { error: 'Someone just booked that slot. Pick another time.' }
    }
    throw err
  }

  if ((booked.rows?.length ?? 0) === 0) {
    await releaseClaim()
    return { error: 'Someone just booked that slot. Pick another time.' }
  }

  if (claim) {
    // A pack session covers the fee, so no card is touched. Recorded against the booking so
    // cancelling it can give the session back — and so that one appointment cannot spend two.
    await recordPackRedemption(claim, bookingId)
  } else if (payingRent) {
    const charged = await chargeRentalFee(bookingId)

    if ('error' in charged) {
      // Ethan's rule: a declined card fails the booking. The slot goes back rather than being
      // held against a fee nobody paid — on a single shared laser an unpaid reservation is a
      // slot removed from everybody else for nothing.
      //
      // Deleting rather than cancelling, because this appointment never really existed: it was a
      // row held for the few hundred milliseconds the charge took. A cancelled booking in the
      // provider's history would be a record of something that did not happen.
      await db.delete(bookings).where(eq(bookings.id, bookingId))
      return { error: charged.error }
    }

    // The receipt, to the person whose card it was. Only here — a credited session charges
    // nothing, and a $0.00 receipt teaches somebody to stop reading this sender.
    //
    // Takes the amount the charge reported rather than re-reading the ledger, so the figure in
    // the email is the one Stripe actually took.
    // `skipped` is a deliberate non-charge — an already-billed retry, or Melanite's own
    // appointment — so there is nothing to send a receipt for.
    if ('charged' in charged) {
      await notifyProviderCharged({
        providerId: user.id,
        serviceName: svc.name,
        when: startTime,
        amountCents: charged.charged.amountCents,
      })
    }
  }

  // Melanite hears about every appointment the moment it takes the laser. Best effort, like
  // every send here — a booking that succeeded and was paid for must not report failure because
  // an email bounced.
  await notifyMelaniteBooked(bookingId)

  redirect(`/app/appointments?booked=${bookingId}`)
}
