'use server'

import { randomBytes } from 'node:crypto'

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
import { providerServices, providers, services } from '@/lib/db/schema'
import { bookingPaymentLinkEmail, sendEmail } from '@/lib/email'
import { notifyMelaniteBooked } from '@/lib/notify-melanite'
import { appOrigin } from '@/lib/stripe/config'
import { isValidEmail, isValidPhone } from '@/lib/validation'
import {
  claimPackSession,
  recordPackRedemption,
  releasePackSession,
  type PackClaim,
} from '@/lib/rental/packs'
import { hasAcceptedRentalTerms } from '@/lib/rental-terms'
import { feeForService, liveScheduleVersion } from '@/lib/rental/schedule'
import { toMoney } from '@/lib/money'
import { paysRent, sharesRevenue } from '@/lib/revenue-model'
import { unsettledRent } from '@/lib/rental/settle'

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
      error:
        'Add a card before booking — Melanite charges the rental fee after your session, not now.',
    }
  }

  // UNPAID RENT BLOCKS THE NEXT BOOKING. This is what replaced "a declined card fails the
  // booking", and it is weaker on purpose: the fee is no longer taken up front, so there is
  // nothing to refuse at the moment the laser is used. The lever left is the session after.
  //
  // FAILED rent only, never merely-unswept. Blocking on "last night's sweep has not run yet"
  // would shut the calendar every morning the cron drifted — turning a latency problem into a
  // correctness one and throwing away the property the whole design rests on. See
  // `unsettledRent`.
  if (payingRent) {
    const owed = await unsettledRent(user.id)
    if (owed.failedCount > 0) {
      return {
        error:
          `Melanite could not take the rent for ${owed.failedCount} ` +
          `${owed.failedCount === 1 ? 'session' : 'sessions'} ($${toMoney(owed.failedCents)}). ` +
          'Update your card on your account page and it will be tried again — booking reopens ' +
          'once it clears.',
      }
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
  }

  // NOTHING IS CHARGED HERE ANY MORE, and that is the change Keoni asked for on 9 October.
  //
  // Until then this is where the money moved: `chargeRentalFee` ran inline, and a declined card
  // deleted the booking again — "a declined card fails the booking", which was self-enforcing
  // because no money meant no slot. Her objection was about the industry, not the mechanism:
  // providers are frequently not paid by their own client until the work is done, so taking
  // their money to hold a slot is the wrong way round.
  //
  // The fee is now taken twelve hours after the session ends, by `lib/rental/settle.ts`. The
  // provider sees the amount before they book and gets a receipt when it is actually taken.
  //
  // WHAT MELANITE GAVE UP. The old rule needed no enforcement; this one does. A provider can
  // take a slot, use the laser and then decline, and the only lever left is refusing their NEXT
  // booking. Four things replace one guarantee: the unpaid-rent gate on booking, the queue item,
  // the nightly digest line, and a person. That is the whole list, and it is weaker on purpose.

  // Melanite hears about every appointment the moment it takes the laser. Best effort, like
  // every send here — a booking that succeeded and was paid for must not report failure because
  // an email bounced.
  await notifyMelaniteBooked(bookingId)

  redirect(`/app/appointments?booked=${bookingId}`)
}

const CHECKOUT_LINK_TTL_DAYS = 7
const EXTERNAL_METHODS = ['groupon', 'cherry', 'cash', 'check', 'other'] as const
type ExternalMethod = (typeof EXTERNAL_METHODS)[number]

/**
 * Books a session for a provider on the original 50/50 split.
 *
 * A SEPARATE ACTION FROM `createBooking`, deliberately, rather than eight branches inside one.
 * Almost nothing is shared: this one takes a client, a price and a discount and writes a
 * checkout link; that one takes none of those and charges rent afterwards. Threading both
 * through one function would leave every reader working out which half applies to them.
 *
 * What IS shared is the one thing that must never diverge: the single-statement insert guarded
 * by `bookings_no_overlap`, the training-course check and the blocked-time check. There is one
 * laser, and a second booking path that forgot any of those would hand the same hour to two
 * people — so they are written identically here and in `createBooking`, and
 * `test/blocked-time.test.ts` asserts that every path taking laser time carries them.
 *
 * Restored on 12 October for Leyla, Brittany and Karly. It is the flow that existed before the
 * rental model, with the two guards added since folded in — the original predates both.
 */
export async function createSplitBooking(
  _prev: BookState,
  formData: FormData,
): Promise<BookState> {
  const user = await requireProvider()

  if (!canBook(user)) {
    const gates = bookingBlockedReasons(user)
    return {
      error: gates.length
        ? gates.map((g) => g.message).join(' ')
        : 'Your account cannot book right now.',
    }
  }

  // The model decides which action is legitimate, not which form happened to post. A provider
  // on rent reaching here would get a client booking with a price on it, which is the mirror
  // image of the bug the split exists to prevent.
  if (!sharesRevenue(user.revenueModel)) {
    return { error: 'Your account books laser time directly. Use the booking form.' }
  }

  const providerServiceId = String(formData.get('providerServiceId') ?? '')
  const startTimeRaw = String(formData.get('startTime') ?? '')
  const clientName = String(formData.get('clientName') ?? '').trim()
  const clientPhone = String(formData.get('clientPhone') ?? '').trim() || null
  const clientEmail = String(formData.get('clientEmail') ?? '').trim().toLowerCase() || null
  const treatmentArea = String(formData.get('treatmentArea') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null

  // Both optional, both validated when present. A client email with a typo is worse than a
  // blank one: the payment link is generated, sent, and silently reaches nobody, while the
  // booking sits looking as though the client was contacted.
  if (clientEmail && !isValidEmail(clientEmail)) {
    return { error: 'That client email doesn’t look right. Check it, or leave it blank.' }
  }
  if (clientPhone && !isValidPhone(clientPhone)) {
    return { error: 'That client phone number doesn’t look right. Check it, or leave it blank.' }
  }
  if (!clientName) return { error: 'Enter the client’s name.' }
  if (!providerServiceId) return { error: 'Choose a service.' }
  if (!startTimeRaw) return { error: 'Choose a time.' }

  const discountTypeRaw = String(formData.get('discountType') ?? 'none')
  const discountValue = Number(formData.get('discountValue') ?? 0)

  // How the client is paying. Empty means the normal route: a checkout link, emailed. Anything
  // else means the money arrives outside this app — a Groupon voucher, cash, a card in person —
  // and generating a payment link for it is how a client pays twice.
  const externalMethodRaw = String(formData.get('externalMethod') ?? '').trim()
  if (externalMethodRaw && !EXTERNAL_METHODS.includes(externalMethodRaw as ExternalMethod)) {
    return { error: 'That is not a payment method we can record.' }
  }
  const externalMethod = (externalMethodRaw || null) as ExternalMethod | null

  if (!['none', 'percent', 'amount'].includes(discountTypeRaw)) {
    return { error: 'That discount type is not valid.' }
  }
  const discountType = discountTypeRaw as 'none' | 'percent' | 'amount'

  if (discountType !== 'none') {
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return { error: 'Enter a discount greater than zero, or choose no discount.' }
    }
    if (discountType === 'percent' && discountValue >= 100) {
      return { error: 'A percentage discount must be under 100%.' }
    }
  }

  const startTime = new Date(startTimeRaw)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }
  if (startTime <= new Date()) return { error: 'Choose a time in the future.' }

  // The service must exist, belong to the caller, be switched on by them, and still be offered
  // platform-wide. All four fail for different reasons and all of them mean no booking.
  const [svc] = await db
    .select({
      price: providerServices.price,
      durationMins: providerServices.durationMins,
      minDurationMins: services.minDurationMins,
      maxDurationMins: services.maxDurationMins,
      name: services.name,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .where(
      and(
        eq(providerServices.id, providerServiceId),
        eq(providerServices.providerId, user.id),
        eq(providerServices.isActive, true),
        eq(services.active, true),
      ),
    )
    .limit(1)

  if (!svc) return { error: 'That service is not available on your profile.' }
  if (Number(svc.price) <= 0) {
    return { error: 'That service has no price set. Set one on My Services first.' }
  }
  if (svc.durationMins < svc.minDurationMins || svc.durationMins > svc.maxDurationMins) {
    return { error: 'That service’s configured duration is outside its allowed range.' }
  }

  const endTime = new Date(startTime.getTime() + svc.durationMins * 60_000)

  const hours = await getLaserHours()
  const dayInDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
    startTime,
  )
  const open = denverInstant(dayInDenver, hours.openTime)
  const close = denverInstant(dayInDenver, hours.closeTime)
  if (startTime < open || endTime > close) {
    return { error: 'That time is outside laser operating hours.' }
  }

  const originalPrice = Number(svc.price)

  // In cents, so a percentage discount cannot land a fraction of a penny off.
  const originalCents = Math.round(originalPrice * 100)
  const discountCents =
    discountType === 'percent'
      ? Math.round(originalCents * (discountValue / 100))
      : discountType === 'amount'
        ? Math.round(discountValue * 100)
        : 0

  // Refuses rather than clamping. Silently turning an over-discount into a free session would
  // misprice it and hide the mistake; comping is a different thing with its own payment source.
  if (discountCents > originalCents) {
    return {
      error: `That discount is more than the ${originalPrice.toFixed(2)} price. Use a smaller amount.`,
    }
  }
  if (discountCents === originalCents) {
    return { error: 'That would make the appointment free. Ask Keoni to comp it instead.' }
  }

  const price = (originalCents - discountCents) / 100

  // For an external payment this figure is the whole point: it is what Keoni invoices a share
  // of. A Groupon booking recorded at $0 tells her to collect half of nothing.
  if (externalMethod && !(price > 0)) {
    return { error: 'Enter what the client is paying — Melanite needs it to work out the split.' }
  }

  const bookingId = crypto.randomUUID()
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + CHECKOUT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)

  // The three guards that make one laser work, as one expression used by both shapes below.
  // Written once here so the two cannot drift from each other; identical in spirit to the
  // statement in `createBooking`, which has to carry the same three.
  const slotIsFree = sql`NOT EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.status IN ('upcoming', 'completed')
       AND b.start_time < ${endTime.toISOString()}::timestamptz
       AND b.end_time   > ${startTime.toISOString()}::timestamptz
  )
  AND NOT ${overlapsTrainingCourse(startTime.toISOString(), endTime.toISOString())}
  AND NOT ${overlapsBlockedTime(startTime.toISOString(), endTime.toISOString())}`

  let booked
  try {
    // Two shapes, one query each. An external payment gets NO checkout link — the CTE that
    // creates one is simply not there, rather than a link written and then ignored. A payment
    // page for money that has already changed hands is how a client pays twice.
    booked = externalMethod
      ? await db.execute(sql`
          INSERT INTO bookings
            (id, provider_id, provider_service_id, client_name, client_phone, client_email,
             treatment_area, notes, original_price, discount_type, discount_value, price,
             payment_source, external_method, duration_mins, start_time, end_time, status)
          SELECT ${bookingId}::uuid, ${user.id}::uuid, ${providerServiceId}::uuid, ${clientName},
                 ${clientPhone}, ${clientEmail}, ${treatmentArea}, ${notes},
                 ${originalPrice.toFixed(2)}::numeric, ${discountType}::discount_type,
                 ${discountValue.toFixed(2)}::numeric, ${price.toFixed(2)}::numeric,
                 'external'::booking_payment_source, ${externalMethod}::payment_method,
                 ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
                 ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
          WHERE ${slotIsFree}
          RETURNING id AS booking_id
        `)
      : await db.execute(sql`
          WITH new_booking AS (
            INSERT INTO bookings
              (id, provider_id, provider_service_id, client_name, client_phone, client_email,
               treatment_area, notes, original_price, discount_type, discount_value, price,
               payment_source, duration_mins, start_time, end_time, status)
            SELECT ${bookingId}::uuid, ${user.id}::uuid, ${providerServiceId}::uuid,
                   ${clientName}, ${clientPhone}, ${clientEmail}, ${treatmentArea}, ${notes},
                   ${originalPrice.toFixed(2)}::numeric, ${discountType}::discount_type,
                   ${discountValue.toFixed(2)}::numeric, ${price.toFixed(2)}::numeric,
                   'checkout_link'::booking_payment_source,
                   ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
                   ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
            WHERE ${slotIsFree}
            RETURNING id
          )
          INSERT INTO checkout_links (booking_id, token, status, expires_at)
          SELECT id, ${token}, 'pending'::checkout_link_status,
                 ${expiresAt.toISOString()}::timestamptz
          FROM new_booking
          RETURNING booking_id
        `)
  } catch (err) {
    // 23P01 — exclusion_violation. The other side of the race committed first, which is the
    // constraint doing its job. Anything else is a real failure and should surface.
    if (isExclusionViolation(err)) {
      return { error: 'Someone just booked that slot. Pick another time.' }
    }
    throw err
  }

  if ((booked.rows?.length ?? 0) === 0) {
    return { error: 'Someone just booked that slot. Pick another time.' }
  }

  await notifyMelaniteBooked(bookingId)

  // Best effort by design: a booking that succeeded must not report failure because an email
  // bounced, and the link is shown on the next screen either way. No link exists for an
  // external payment, so there is nothing to send.
  let emailed = false
  if (clientEmail && !externalMethod) {
    try {
      const result = await sendEmail({
        to: clientEmail,
        ...bookingPaymentLinkEmail({
          clientName,
          providerName: `${user.firstName} ${user.lastName}`,
          serviceName: svc.name,
          when: startTime.toLocaleString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'America/Denver',
          }),
          amount: `$${price.toFixed(2)}`,
          url: `${await appOrigin()}/pay/${token}`,
        }),
      })
      emailed = result.delivered
    } catch (err) {
      console.error('[email] booking payment link failed', err)
    }
  }

  redirect(
    externalMethod
      ? `/app/appointments?booked=${bookingId}&external=${externalMethod}`
      : `/app/appointments?booked=${bookingId}&emailed=${emailed ? '1' : '0'}`,
  )
}
