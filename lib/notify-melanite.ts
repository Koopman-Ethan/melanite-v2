import 'server-only'

import { eq, sql } from 'drizzle-orm'

import { clientLabel } from '@/lib/booking-labels'
import { db } from '@/lib/db'
import {
  bookings,
  endOfUseChecklists,
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
  deskCloseoutEmail,
  deskMedicalDirectorEmail,
  deskPaymentReceivedEmail,
  deskProviderAccessEmail,
  deskRoomRentalEmail,
  rentalChargedEmail,
  roomDateLabel,
  sendEmail,
} from '@/lib/email'
import { hasCurrentLicense } from '@/lib/auth/dal'
import type { SessionUser } from '@/lib/auth/session'
import { END_OF_USE_ITEMS, reportedLabelsFor } from '@/lib/end-of-use'
import { toMoney } from '@/lib/money'
import { appOrigin } from '@/lib/stripe/config'

/** The five items that mean something WHEN ticked. Everything else is ticked on every row. */
const CONDITIONAL_KEYS = new Set(END_OF_USE_ITEMS.filter((i) => !i.required).map((i) => i.key))

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
      // The only money on a rental booking. Without these `bookingPaymentSummary` has nothing
      // to report and says "NO FEE RECORDED" — which is meant to be the alarm for a session
      // that slipped through uncharged, and was firing on every successful booking instead.
      rentalCents: sql<number | null>`(
        select round(sum(l.gross_amount) * 100)::int from ledger_entries l
        where l.subject_type = 'booking' and l.subject_id = ${bookings.id}
          and l.source = 'rental_fee'
      )`,
      paidFromPack: sql<boolean>`exists (
        select 1 from provider_pack_redemptions r
        where r.booking_id = ${bookings.id} and r.voided_at is null
      )`,
      /** The provider's own account of why it did not happen. Null on a booking, obviously, and
       *  on the four non-rental paths to `cancelled` that never ask for one. */
      outcomeReason: bookings.outcomeReason,
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

async function notifyBooking(
  bookingId: string,
  event: 'booked' | 'cancelled' | 'no_show',
): Promise<void> {
  try {
    const row = await bookingDetail(bookingId)
    if (!row) return

    // Whether this one is waiting on Keoni, and what the provider said about it.
    //
    // THE PRIMARY SIGNAL that something needs deciding. `/app/admin/queue` is the list, but a
    // list only works for somebody who remembers to open it — and under the rental model this
    // is every cancellation and every no-show, not an occasional exception. The prompt has to
    // arrive on its own, at the moment it is created, with the provider's words in it.
    const awaitingDecision =
      event !== 'booked' &&
      row.paymentSource === 'rental' &&
      (row.paidFromPack || Number(row.rentalCents ?? 0) > 0)

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskBookingEmail({
        event,
        clientName: clientLabel(row.clientName),
        providerName: `${row.providerFirst} ${row.providerLast}`,
        serviceName: row.serviceName,
        when: appointmentWhen(row.startTime),
        durationMins: row.durationMins,
        paying: bookingPaymentSummary({
          paymentSource: row.paymentSource,
          externalMethod: row.externalMethod,
          price: row.price,
          rentCents: row.rentalCents === null ? null : Number(row.rentalCents),
          paidFromPack: row.paidFromPack,
        }),
        outcomeReason: awaitingDecision ? (row.outcomeReason ?? 'nothing recorded') : null,
        // Straight to the queue when there is a decision to make, rather than the calendar.
        // The whole message is about a thing that needs doing, so the button should go where it
        // gets done.
        url: `${await appOrigin()}${awaitingDecision ? '/app/admin/queue' : '/app/admin/calendar'}`,
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

/** A session nobody turned up for.
 *
 *  New with the held-rent review. It used to need no alert at all: a no-show refunded itself and
 *  there was nothing for Keoni to do, so the only trace was a status on a page. Now it holds the
 *  provider's money until she decides, which makes it the same kind of event as a cancellation
 *  and needs telling about in the same way. */
export async function notifyMelaniteNoShow(bookingId: string): Promise<void> {
  await notifyBooking(bookingId, 'no_show')
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
        // The OTHER two gates. A medical director going active is one of three things that
        // have to be true, and on its own it decides nothing.
        bookingEnabled: providers.bookingEnabled,
        licenseExpiry: providers.licenseExpiry,
      })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1)

    if (!row) return

    const origin = await appOrigin()

    // "Restored" has to mean they can actually book, not that one gate moved.
    //
    // It did not. A provider finishing onboarding pays for their medical director, this fires,
    // and they were told "booking is switched back on, you can create appointments straight
    // away" while `bookingEnabled` was still false and the booking page was still turning them
    // away. Worse for a new provider, who was being told something was back ON that had never
    // been on at all.
    //
    // Melanite still hears about it, and that message is the useful one: a provider who is paid
    // up and waiting on somebody to clear them is an action for Keoni, not an error.
    const licenceOk =
      hasCurrentLicense({ licenseExpiry: row.licenseExpiry } as unknown as SessionUser)
    const canBookNow = next === 'active' && row.bookingEnabled && licenceOk
    const restored = next === 'active'

    // The provider first. They are the one who cannot work, and unlike Melanite they have no
    // other way of finding out — there is no banner until they try to book and are turned away.
    if (row.email && (!restored || canBookNow)) {
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
        stillBlocked: restored && !canBookNow,
        url: `${origin}/app/admin/providers`,
      }),
    })
  } catch (err) {
    console.error(`[email] booking access ${next} alert failed for provider`, providerId, err)
  }
}

/** Money has arrived. Sent for every Stripe purchase — a booking, a package, a prepaid top-up.
 *
 *  The desk-side counterpart to `notifyProviderPaid` in `lib/stripe/handlers.ts`, which tells the
 *  PROVIDER their share. Keoni received nothing at all when a payment landed until this existed.
 *
 *  TWO DELIBERATE DEPARTURES from the shape of everything else in this file.
 *
 *  It takes VALUES rather than an id. Every other function here re-queries by id, which is right
 *  when the caller only has one. This caller has just written the ledger row and is holding the
 *  exact figures the charge was built from — reading them back from a second query could disagree
 *  with what Stripe actually took, and the whole point of the email is to report the real charge.
 *
 *  It checks NO preference. `notifyProviderPaid` is gated on `providers.notifyBookingConfirmed`,
 *  which is a provider's own setting; inheriting it would let a provider switching off their
 *  receipts also silence the business owner. This is Melanite's own inbox and nothing may turn it
 *  off.
 *
 *  Best effort and never throws, like the rest of this file: a webhook that fails on an email is
 *  one Stripe replays, and the money is already recorded. */
/** Tells a PROVIDER what their card was just charged to book the laser.
 *
 *  The counterpart to `notifyProviderPaid`, which told them a client had paid and cannot fire
 *  any more. Gated on the same `providers.notifyBookingConfirmed` preference, because it is the
 *  same question about the opposite direction of money — and like that one, a provider is
 *  allowed to switch their own receipts off.
 *
 *  Takes the AMOUNT rather than re-deriving it, for the reason `notifyMelanitePaid` states: the
 *  caller is holding the figure the charge was actually built from, and a second query could
 *  disagree with what Stripe really took.
 *
 *  Only called when money moved. A session covered by a credited grant charges nothing, and a
 *  receipt for $0.00 is a message that teaches somebody to ignore this sender.
 *
 *  Best effort and never throws. The booking is made and the card is charged by the time this
 *  runs; a bounced email must not undo either.
 */
export async function notifyProviderCharged(input: {
  providerId: string
  serviceName: string
  when: Date
  amountCents: number
}): Promise<void> {
  try {
    const [provider] = await db
      .select({
        email: providers.email,
        firstName: providers.firstName,
        cardLast4: providers.billingCardLast4,
        wants: providers.notifyBookingConfirmed,
      })
      .from(providers)
      .where(eq(providers.id, input.providerId))
      .limit(1)

    if (!provider?.wants) return

    await sendEmail({
      to: provider.email,
      ...rentalChargedEmail({
        firstName: provider.firstName,
        serviceName: input.serviceName,
        when: appointmentWhen(input.when),
        charged: `$${toMoney(input.amountCents)}`,
        cardLast4: provider.cardLast4,
        url: `${await appOrigin()}/app/charges`,
      }),
    })
  } catch (err) {
    console.error('[email] rental charge receipt failed for provider', input.providerId, err)
  }
}

export async function notifyMelanitePaid(input: {
  kind: 'booking' | 'package' | 'prepaid'
  clientName: string | null
  providerName: string
  what: string
  when: string | null
  /** Excludes the tip, matching how the ledger stores it. */
  grossCents: number
  tipCents: number
  isHouse: boolean
}): Promise<void> {
  try {
    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskPaymentReceivedEmail({
        kind: input.kind,
        // Anonymous checkout leaves no name on the row. "A client" is honest; a gap in the
        // sentence reads as a bug — the same fallback `notifyProviderPaid` makes.
        clientName: input.clientName?.trim() || 'A client',
        providerName: input.providerName,
        what: input.what,
        when: input.when,
        // What actually left the card. The ledger's gross excludes the tip; the client's
        // statement does not, and this email is about the statement.
        charged: `$${toMoney(input.grossCents + input.tipCents)}`,
        tip: input.tipCents > 0 ? `$${toMoney(input.tipCents)}` : null,
        isHouse: input.isHouse,
        url: `${await appOrigin()}/app/admin/revenue`,
      }),
    })
  } catch (err) {
    console.error('[email] melanite payment notification failed', err)
  }
}

/** A provider has closed out the suite after a session.
 *
 *  Sent for EVERY close-out, not only the ones reporting a fault. Keoni asked to be told each
 *  time, and at one to three appointments a day that is a handful of emails — the subject line
 *  does the triage so a device issue is visible without opening anything.
 *
 *  Best effort, after the row exists, like everything else here. A close-out that was filed must
 *  never be lost because the email describing it could not be sent. */
export async function notifyCloseout(checklistId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        recordedAt: endOfUseChecklists.recordedAt,
        completedItems: endOfUseChecklists.completedItems,
        deviceIssue: endOfUseChecklists.deviceIssue,
        deviceIssueNote: endOfUseChecklists.deviceIssueNote,
        note: endOfUseChecklists.note,
        bookingId: endOfUseChecklists.bookingId,
        startTime: bookings.startTime,
        serviceName: services.name,
        firstName: providers.firstName,
        lastName: providers.lastName,
      })
      .from(endOfUseChecklists)
      .innerJoin(providers, eq(endOfUseChecklists.providerId, providers.id))
      .innerJoin(bookings, eq(endOfUseChecklists.bookingId, bookings.id))
      .innerJoin(providerServices, eq(bookings.providerServiceId, providerServices.id))
      .innerJoin(services, eq(providerServices.serviceId, services.id))
      .where(eq(endOfUseChecklists.id, checklistId))
      .limit(1)

    if (!row) return

    await sendEmail({
      to: MELANITE_NOTIFY_EMAIL,
      ...deskCloseoutEmail({
        providerName: `${row.firstName} ${row.lastName}`,
        serviceName: row.serviceName,
        when: appointmentWhen(row.startTime),
        deviceIssue: row.deviceIssue,
        deviceIssueNote: row.deviceIssueNote,
        // Only the conditional items are worth listing: the required twenty are ticked on every
        // close-out, so naming them would be twenty lines that say nothing.
        cameUpLabels: reportedLabelsFor(
          row.completedItems.filter((k) => CONDITIONAL_KEYS.has(k)),
        ),
        note: row.note,
        url: `${await appOrigin()}/app/admin/equipment`,
      }),
    })
  } catch (err) {
    console.error('[email] close-out alert failed for checklist', checklistId, err)
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

    const origin = await appOrigin()

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
