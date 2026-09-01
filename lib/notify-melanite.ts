import 'server-only'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import {
  bookings,
  medicalDirectorCredentials,
  providerServices,
  providers,
  roomBookings,
  services,
} from '@/lib/db/schema'
import {
  MELANITE_NOTIFY_EMAIL,
  ROOM_SLOT_LABELS,
  appointmentWhen,
  bookingAccessLostEmail,
  bookingAccessRestoredEmail,
  bookingPaymentSummary,
  deskBookingEmail,
  deskMedicalDirectorEmail,
  deskProviderAccessEmail,
  deskRoomRentalEmail,
  roomDateLabel,
  sendEmail,
} from '@/lib/email'
import { appOrigin } from '@/lib/stripe/config'

// Notifications about things that have already happened.
//
// Named for the calendar alerts it started as, and now also carries the booking-access alerts,
// which go to the PROVIDER as well as to Melanite. The cohesion was never the calendar: it is
// best-effort mail, looked up by id, sent after the fact, never throwing.
//
// Every function here is BEST EFFORT and never throws. Each is called after the thing it
// describes has already been committed — an appointment booked, a cancellation recorded, a room
// rental paid for, a booking gate closed — so a failed send must never be mistaken for a failed
// operation. That is the
// same rule `sendEmail` itself follows, and the same reason `notifyProviderPaid` in
// `lib/stripe/handlers.ts` swallows its errors; these add the try/catch because a JOIN can fail
// where a send cannot.
//
// They live in `lib/` rather than beside their callers because five call sites across four
// modules need them, and because a `'use server'` file may only export server actions.

/** The one join every appointment alert needs. Written once here; the same shape exists in
 *  `notifyCancelled` and `confirmBooking` for the CLIENT emails, which need different columns. */
async function bookingDetail(bookingId: string) {
  const [row] = await db
    .select({
      clientName: bookings.clientName,
      startTime: bookings.startTime,
      durationMins: bookings.durationMins,
      price: bookings.price,
      paymentSource: bookings.paymentSource,
      externalMethod: bookings.externalMethod,
      serviceName: services.name,
      providerFirst: providers.firstName,
      providerLast: providers.lastName,
    })
    .from(bookings)
    .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .innerJoin(providers, eq(bookings.providerId, providers.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)

  return row ?? null
}

async function notifyBooking(bookingId: string, event: 'booked' | 'cancelled'): Promise<void> {
  try {
    const row = await bookingDetail(bookingId)
    if (!row) return

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskBookingEmail({
        event,
        clientName: row.clientName,
        providerName: `${row.providerFirst} ${row.providerLast}`,
        serviceName: row.serviceName,
        when: appointmentWhen(row.startTime),
        durationMins: row.durationMins,
        paying: bookingPaymentSummary({
          paymentSource: row.paymentSource,
          externalMethod: row.externalMethod,
          price: row.price,
        }),
        url: `${await appOrigin()}/app/admin/calendar`,
      }),
    })
  } catch (err) {
    console.error(`[email] Melanite ${event} alert failed for booking`, bookingId, err)
  }
}

/** An appointment now occupies the laser. Called from every path that creates a booking row a
 *  provider chose to make: `/app/book`, a package redemption, and a prepaid redemption.
 *
 *  Deliberately NOT called from `createManualBooking` — that is the admin tool, Keoni is
 *  usually the person typing into it, and a past-dated entry lands as `completed` rather than
 *  on the upcoming calendar at all. */
export async function notifyMelaniteBooked(bookingId: string): Promise<void> {
  await notifyBooking(bookingId, 'booked')
}

/** An appointment has left the calendar. Called once, from `notifyCancelled`, which is already
 *  the single funnel for the ordinary, package and prepaid cancellations. */
export async function notifyMelaniteCancelled(bookingId: string): Promise<void> {
  await notifyBooking(bookingId, 'cancelled')
}

/** The rental room was taken or given back.
 *
 *  `booked` fires on the `confirmed` transition in the Stripe webhook, not on the pending hold
 *  `startRoomRental` writes before checkout. A hold is not a rental: it expires on its own, and
 *  announcing one would leave an unmatched booking email behind every abandoned checkout. */
export async function notifyMelaniteRoomRental(
  roomBookingId: string,
  event: 'booked' | 'cancelled',
  options: { awaitingRefundDecision?: boolean } = {},
): Promise<void> {
  try {
    const [row] = await db
      .select({
        rentalDate: roomBookings.rentalDate,
        slotType: roomBookings.slotType,
        price: roomBookings.price,
        providerFirst: providers.firstName,
        providerLast: providers.lastName,
      })
      .from(roomBookings)
      .innerJoin(providers, eq(roomBookings.providerId, providers.id))
      .where(eq(roomBookings.id, roomBookingId))
      .limit(1)

    if (!row) return

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskRoomRentalEmail({
        event,
        providerName: `${row.providerFirst} ${row.providerLast}`,
        slotLabel: ROOM_SLOT_LABELS[row.slotType],
        dateLabel: roomDateLabel(row.rentalDate),
        price: row.price,
        awaitingRefundDecision: options.awaitingRefundDecision,
        url: `${await appOrigin()}/app/admin/calendar`,
      }),
    })
  } catch (err) {
    console.error(`[email] Melanite room ${event} alert failed for`, roomBookingId, err)
  }
}

/** The medical-director gate opened or closed for a provider.
 *
 *  Called from the FOUR places that write `providers.medicalDirectorStatus`, and only when that
 *  column actually moved — the handlers decide that with a conditional UPDATE, because Stripe
 *  sends `invoice.payment_failed` again on every dunning retry and a provider does not want to
 *  be told six times about one decline.
 *
 *  `tellMelanite` is false for the admin tool: Keoni opening the gate herself by recording a
 *  direct payment does not need an email telling her she did. Same reasoning that keeps the
 *  manual booking tool off the calendar alerts.
 */
export async function notifyBookingAccessChanged(
  providerId: string,
  next: 'past_due' | 'inactive' | 'active',
  options: { tellMelanite?: boolean } = {},
): Promise<void> {
  const tellMelanite = options.tellMelanite ?? true

  try {
    const [row] = await db
      .select({
        firstName: providers.firstName,
        lastName: providers.lastName,
        email: providers.email,
        billingCustomerId: providers.stripeBillingCustomerId,
      })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1)

    if (!row) return

    const origin = await appOrigin()
    const restored = next === 'active'

    // The provider first. They are the one who cannot work, and unlike Melanite they have no
    // other way of finding out — there is no banner until they try to book and are turned away.
    if (row.email) {
      await sendEmail({
        to: row.email,
        ...(restored
          ? bookingAccessRestoredEmail({
              firstName: row.firstName,
              url: `${origin}/app`,
            })
          : bookingAccessLostEmail({
              firstName: row.firstName,
              reason: next,
              url: `${origin}/app/membership`,
            })),
      })
    }

    if (!tellMelanite) return

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskProviderAccessEmail({
        event: restored ? 'restored' : 'lost',
        providerName: `${row.firstName} ${row.lastName}`,
        reason: next,
        // Decides whether this is hers to deal with: without a billing customer there is no
        // portal to send them to, so they cannot fix it themselves however clear the email is.
        canSelfServe: row.billingCustomerId !== null,
        url: `${origin}/app/admin/providers`,
      }),
    })
  } catch (err) {
    console.error(`[email] booking access ${next} alert failed for provider`, providerId, err)
  }
}

/** A provider filed or changed her own medical director.
 *
 *  Best effort, like everything else here: she has done her part, and an email that fails must
 *  never tell her otherwise. The cost of it failing is that Melanite finds out on the roster
 *  instead, which is where the details live anyway.
 */
export async function notifyMedicalDirectorSubmitted(
  providerId: string,
  options: { changed: boolean },
): Promise<void> {
  try {
    const [row] = await db
      .select({
        firstName: providers.firstName,
        lastName: providers.lastName,
        status: providers.medicalDirectorStatus,
        bookingEnabled: providers.bookingEnabled,
        directorName: medicalDirectorCredentials.name,
        directorCredentials: medicalDirectorCredentials.credentials,
        npi: medicalDirectorCredentials.npi,
        licenseNumber: medicalDirectorCredentials.licenseNumber,
        licenseState: medicalDirectorCredentials.licenseState,
        licenseExpiry: medicalDirectorCredentials.licenseExpiry,
        contactEmail: medicalDirectorCredentials.contactEmail,
        contactPhone: medicalDirectorCredentials.contactPhone,
      })
      .from(providers)
      .innerJoin(
        medicalDirectorCredentials,
        eq(medicalDirectorCredentials.providerId, providers.id),
      )
      .where(eq(providers.id, providerId))
      .limit(1)

    if (!row) return

    const origin = appOrigin()

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskMedicalDirectorEmail({
        providerName: `${row.firstName} ${row.lastName}`,
        directorName: row.directorName,
        directorCredentials: row.directorCredentials,
        npi: row.npi,
        licenseNumber: row.licenseNumber,
        licenseState: row.licenseState,
        licenseExpiry: row.licenseExpiry,
        contactEmail: row.contactEmail,
        contactPhone: row.contactPhone,
        changed: options.changed,
        // Both gates, not just the director one — "she still cannot book" is only true if
        // something is actually still shut, and telling Melanite to act when nothing is needed
        // is how these emails become noise.
        stillBlocked: row.status !== 'active' || !row.bookingEnabled,
        url: `${origin}/app/admin/providers`,
      }),
    })
  } catch (err) {
    console.error('[email] medical director alert failed for provider', providerId, err)
  }
}
