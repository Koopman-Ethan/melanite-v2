'use server'

import { randomBytes } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { bookings, checkoutLinks, providerServices, services } from '@/lib/db/schema'
import { appointmentWhen, bookingPaymentLinkEmail, sendEmail } from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

// Getting a payment link back to a client after the day it was created.
//
// The link was shown exactly once, in the banner immediately after booking, and was unreachable
// afterwards — no card displayed it, nothing resent it. `docs/decisions.md` records the original
// version of this bug as "created and shown to nobody"; the banner fixed the moment of booking
// and left the day after untouched. A client saying "can you send that again?" had no answer,
// which is a large part of why a completed appointment can sit unpaid.
//
// Both actions below are scoped to the caller's own bookings, and that is not incidental: the
// token is a bearer credential for somebody's payment page, so reading one by guessing booking
// ids must not be possible. Same reasoning `getBookingLink` already documents.

/** Same window a link gets when the booking is created. */
const CHECKOUT_LINK_TTL_DAYS = 7

export interface LinkState {
  error?: string
  success?: string
}

/** Everything the email needs, scoped to the owner in one query. */
async function payableBooking(bookingId: string, providerId: string) {
  const [row] = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      startTime: bookings.startTime,
      price: bookings.price,
      serviceName: services.name,
      token: checkoutLinks.token,
      status: checkoutLinks.status,
      expiresAt: checkoutLinks.expiresAt,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .innerJoin(checkoutLinks, eq(checkoutLinks.bookingId, bookings.id))
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, providerId)))
    .limit(1)

  return row ?? null
}

/**
 * Emails the existing link again.
 *
 * Deliberately does NOT rotate the token. A client who still has the first message must not find
 * it dead because somebody pressed resend — and the common case is a link that was never seen,
 * not one that was compromised.
 */
export async function resendBookingLink(bookingId: string): Promise<LinkState> {
  const user = await requireProvider()
  const booking = await payableBooking(bookingId, user.id)

  if (!booking) return { error: 'That appointment has no payment link.' }
  if (booking.status === 'paid') return { error: 'That one is already paid.' }
  if (booking.status === 'cancelled') return { error: 'That link was cancelled with the booking.' }
  if (booking.expiresAt < new Date()) {
    // Sending it would deliver a page that says "expired", which is worse than saying so here.
    return { error: 'That link has expired. Issue a new one and it will send with it.' }
  }
  if (!booking.clientEmail) {
    return { error: 'No email on this appointment — copy the link and text it instead.' }
  }

  const result = await sendEmail({
    to: booking.clientEmail,
    ...bookingPaymentLinkEmail({
      clientName: booking.clientName,
      providerName: `${user.firstName} ${user.lastName}`,
      serviceName: booking.serviceName,
      when: appointmentWhen(booking.startTime),
      amount: `$${Number(booking.price).toFixed(2)}`,
      url: `${await appOrigin()}/pay/${booking.token}`,
    }),
  })

  // Reports what actually happened rather than claiming a send. The same honesty the booking
  // banner already applies — "emailed" and "nothing was sent" need different words.
  if (!result.delivered) {
    return {
      error:
        result.reason === 'not-configured'
          ? 'Email is not set up here, so nothing was sent — copy the link and send it yourself.'
          : `That didn’t send: ${result.detail ?? 'the email service refused it'}. Copy the link instead.`,
    }
  }

  return { success: `Sent again to ${booking.clientEmail}.` }
}

/**
 * Replaces an expired link with a fresh one.
 *
 * `checkout_links` is unique on `booking_id`, so this rotates the existing row rather than adding
 * a second — one appointment, one link, which is what stops a client being shown two payment
 * pages for the same treatment.
 *
 * Only when EXPIRED. Rotating a live token would silently kill a link the client may already be
 * holding, and "I sent it, they clicked it, it was dead" is a worse failure than the one this
 * fixes. An expired link has no such reader.
 */
export async function reissueBookingLink(bookingId: string): Promise<LinkState> {
  const user = await requireProvider()
  const booking = await payableBooking(bookingId, user.id)

  if (!booking) return { error: 'That appointment has no payment link.' }
  if (booking.status === 'paid') return { error: 'That one is already paid.' }
  if (booking.status === 'cancelled') return { error: 'That link was cancelled with the booking.' }
  if (booking.expiresAt > new Date()) {
    return { error: 'That link still works — send it again rather than replacing it.' }
  }

  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + CHECKOUT_LINK_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db
    .update(checkoutLinks)
    .set({ token, status: 'pending', expiresAt })
    .where(eq(checkoutLinks.bookingId, booking.id))

  revalidatePath('/app/appointments')

  if (!booking.clientEmail) {
    return { success: 'New link ready. Copy it and send it across.' }
  }

  const result = await sendEmail({
    to: booking.clientEmail,
    ...bookingPaymentLinkEmail({
      clientName: booking.clientName,
      providerName: `${user.firstName} ${user.lastName}`,
      serviceName: booking.serviceName,
      when: appointmentWhen(booking.startTime),
      amount: `$${Number(booking.price).toFixed(2)}`,
      url: `${await appOrigin()}/pay/${token}`,
    }),
  })

  // The link exists either way. A failed email must not read as a failed reissue.
  return {
    success: result.delivered
      ? `New link sent to ${booking.clientEmail}.`
      : 'New link ready — the email did not send, so copy it and send it yourself.',
  }
}
