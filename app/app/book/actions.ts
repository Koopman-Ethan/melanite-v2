'use server'

import { randomBytes } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { redirect } from 'next/navigation'

import { canBook, bookingBlockedReasons, requireProvider } from '@/lib/auth/dal'
import { denverInstant, getLaserHours } from '@/lib/db/queries/availability'
import { db } from '@/lib/db'
import { providerServices, services } from '@/lib/db/schema'
import { bookingPaymentLinkEmail, sendEmail } from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

export interface BookState {
  error?: string
}

const CHECKOUT_LINK_TTL_DAYS = 7

/** Create a booking and its checkout link.
 *
 *  v1 calls this "the critical atomic write". The ordering is the point: every gate and
 *  validation first, then a collision check that is part of the write itself rather than a
 *  step before it. See the statement below for how that is done here.
 */
export async function createBooking(_prev: BookState, formData: FormData): Promise<BookState> {
  const user = await requireProvider()

  // Gates first. canBook() covers bookingEnabled, medicalDirectorStatus and licence expiry;
  // an inactive account never gets a session at all.
  if (!canBook(user)) {
    const gates = bookingBlockedReasons(user)
    return {
      error: gates.length ? gates.map((g) => g.message).join(' ') : 'Your account cannot book right now.',
    }
  }

  const providerServiceId = String(formData.get('providerServiceId') ?? '')
  const startTimeRaw = String(formData.get('startTime') ?? '')
  const clientName = String(formData.get('clientName') ?? '').trim()
  const clientPhone = String(formData.get('clientPhone') ?? '').trim() || null
  const clientEmail = String(formData.get('clientEmail') ?? '').trim().toLowerCase() || null
  const treatmentArea = String(formData.get('treatmentArea') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null
  const discountTypeRaw = String(formData.get('discountType') ?? 'none')
  const discountValue = Number(formData.get('discountValue') ?? 0)

  if (!clientName) return { error: 'Enter the client’s name.' }
  if (!providerServiceId) return { error: 'Choose a service.' }
  if (!startTimeRaw) return { error: 'Choose a time.' }
  if (!['none', 'percent', 'amount'].includes(discountTypeRaw)) {
    return { error: 'That discount type is not valid.' }
  }
  const discountType = discountTypeRaw as 'none' | 'percent' | 'amount'

  if (discountType !== 'none') {
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return { error: 'Enter a discount greater than zero, or choose no discount.' }
    }
    // v1 capped percentages below 100. The same intent applies to a flat amount, but the
    // ceiling depends on the price, so it is checked once the service is known.
    if (discountType === 'percent' && discountValue >= 100) {
      return { error: 'A percentage discount must be under 100%.' }
    }
  }

  const startTime = new Date(startTimeRaw)
  if (Number.isNaN(startTime.getTime())) return { error: 'That time is not valid.' }
  if (startTime <= new Date()) return { error: 'Choose a time in the future.' }

  // The service must exist, belong to the caller, be switched on by them, and still be offered
  // platform-wide. v1 checked all four; they fail for different reasons and all of them mean
  // the booking must not happen.
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
  if (Number(svc.price) <= 0) return { error: 'That service has no price set.' }
  if (svc.durationMins < svc.minDurationMins || svc.durationMins > svc.maxDurationMins) {
    return { error: 'That service’s configured duration is outside its allowed range.' }
  }

  const endTime = new Date(startTime.getTime() + svc.durationMins * 60_000)

  // Operating hours, evaluated on the booking's own date in Mountain Time.
  const hours = await getLaserHours()
  const dayInDenver = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(startTime)
  const open = denverInstant(dayInDenver, hours.openTime)
  const close = denverInstant(dayInDenver, hours.closeTime)
  if (startTime < open || endTime > close) {
    return { error: 'That time is outside laser operating hours.' }
  }

  const originalPrice = Number(svc.price)

  // Computed in cents so a percentage discount cannot land a fraction of a penny off — the
  // same reasoning as the package builder's total check.
  const originalCents = Math.round(originalPrice * 100)
  const discountCents =
    discountType === 'percent'
      ? Math.round(originalCents * (discountValue / 100))
      : discountType === 'amount'
        ? Math.round(discountValue * 100)
        : 0

  // A discount may not exceed the price. Comping an appointment is a different thing with a
  // different payment source, so this refuses rather than clamping to zero — silently turning
  // an over-discount into a free session would misprice it and hide the mistake.
  if (discountCents > originalCents) {
    return {
      error: `That discount is more than the ${originalPrice.toFixed(2)} price. Use a smaller amount.`,
    }
  }
  if (discountCents === originalCents) {
    return { error: 'That would make the appointment free. Book it as comped instead.' }
  }

  const price = (originalCents - discountCents) / 100

  const bookingId = crypto.randomUUID()
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + CHECKOUT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)

  // One statement, so the booking and its checkout link are written together or not at all.
  //
  // A transaction wrapper would not do here: the neon-http driver is non-interactive, so it
  // cannot branch on a result mid-transaction. The CTE solves that — the link is inserted from
  // the booking's output, so it can only exist if the booking does.
  //
  // The NOT EXISTS is the FRIENDLY check, not the guarantee. It is what turns the common case
  // into a readable message instead of a database error. It is not a lock: under READ COMMITTED
  // two concurrent statements each evaluate it against a snapshot that cannot see the other's
  // uncommitted row, so both find the slot free and both insert. The real guarantee is the
  // `bookings_no_overlap` EXCLUDE constraint (migration 0013), which is why the insert is
  // wrapped below — a violation there means somebody won the race, not that anything is broken.
  let booked
  try {
    booked = await db.execute(sql`
    WITH new_booking AS (
      INSERT INTO bookings
        (id, provider_id, provider_service_id, client_name, client_phone, client_email,
         treatment_area, notes, original_price, discount_type, discount_value, price,
         payment_source, duration_mins, start_time, end_time, status)
      SELECT ${bookingId}::uuid, ${user.id}::uuid, ${providerServiceId}::uuid, ${clientName},
             ${clientPhone}, ${clientEmail}, ${treatmentArea}, ${notes},
             ${originalPrice.toFixed(2)}::numeric, ${discountType}::discount_type,
             ${discountValue.toFixed(2)}::numeric, ${price.toFixed(2)}::numeric,
             'checkout_link'::booking_payment_source,
             ${svc.durationMins}, ${startTime.toISOString()}::timestamptz,
             ${endTime.toISOString()}::timestamptz, 'upcoming'::booking_status
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.status IN ('upcoming', 'completed')
          AND b.start_time < ${endTime.toISOString()}::timestamptz
          AND b.end_time   > ${startTime.toISOString()}::timestamptz
      )
      RETURNING id
    )
    INSERT INTO checkout_links (booking_id, token, status, expires_at)
    SELECT id, ${token}, 'pending'::checkout_link_status, ${expiresAt.toISOString()}::timestamptz
    FROM new_booking
    RETURNING booking_id
  `)
  } catch (err) {
    // 23P01 — exclusion_violation. The other side of the race committed first, which is the
    // constraint doing exactly its job. Anything else is a real failure and should surface.
    if (String((err as { code?: string })?.code ?? err).includes('23P01')) {
      return { error: 'Someone just booked that slot. Pick another time.' }
    }
    throw err
  }

  if ((booked.rows?.length ?? 0) === 0) {
    return { error: 'Someone just booked that slot. Pick another time.' }
  }

  // Send the link the moment it exists. Until now it was created and shown to nobody — the
  // provider had no way to get it to the client, which makes the whole checkout flow
  // unreachable in practice.
  //
  // Best effort by design: a booking that succeeded must not be reported as failed because an
  // email bounced, and the link is displayed on the next screen either way.
  let emailed = false
  if (clientEmail) {
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

  redirect(`/app/appointments?booked=${bookingId}&emailed=${emailed ? '1' : '0'}`)
}
