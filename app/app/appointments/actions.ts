'use server'

import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { rentOwedFor, type RentOwed } from '@/lib/rental/review'

import { clientLabel } from '@/lib/booking-labels'
import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { getCheckoutSettings } from '@/lib/db/queries/checkout'
import {
  bookings,
  checkoutLinks,
  packageRedemptions,
  prepaidRedemptions,
  providerServices,
  providers,
  services,
} from '@/lib/db/schema'
import { appointmentWhen, bookingCancelledEmail, sendEmail } from '@/lib/email'
import { notifyMelaniteCancelled, notifyMelaniteNoShow } from '@/lib/notify-melanite'
import { chargeBookingFee } from '@/lib/stripe/fees'

// Ported from v1's three booking-action endpoints. The preconditions are theirs, deliberately
// — they encode real money rules, not incidental validation.

export interface ActionState {
  error?: string
  success?: string
  /** Set when a fee was attempted but nothing was charged — no card, no consent, nothing to
   *  base an amount on. Not an error: the status change still happened, and the provider needs
   *  to know the fee did not. */
  feeNote?: string
}

/** Cancel an ordinary booking.
 *
 *  v1's guard: if a live package redemption points at this booking, this endpoint REFUSES
 *  (USE_PACKAGE_CANCEL) because cancelling here would destroy a session the client already
 *  paid for. That guard is kept — the UI picks the right action from `paymentSource`, but the
 *  server must not depend on the UI having got it right. It fails closed.
 */
/** How a returned rental fee is reported back to the provider.
 *
 *  Said out loud rather than left to the charges page, because money coming back is the half of
 *  a refund people do not check for. An empty string when nothing moved — most appointments
 *  before the rental model, and Melanite's own.
 */
/** Short enough that a real answer always clears it, long enough that "n/a" does not.
 *
 *  Keoni has to make a money decision off these, so a box somebody can dismiss with a keystroke
 *  would leave her exactly where she was before the feature existed. It is not a quality bar —
 *  nothing can enforce that — it is a speed bump in front of the reflex to skip the dialog. */
const MIN_REASON = 10

/** The fee as a phrase, whether or not it has been taken. A pack session has no cash amount. */
function rentAmount(owed: RentOwed): string {
  return owed.kind === 'pack' ? '' : `$${(owed.cents / 100).toFixed(2)}`
}

/** What the provider is told about their rent, now that nothing refunds itself.
 *
 *  It used to announce a refund that had already happened. Saying that now would be a lie: the
 *  fee is held, Keoni decides, and the provider finds out when she does. Promising nothing is
 *  the point — "sometimes its the clients fault, and not the providers", and this message is
 *  written before anybody knows which. */
function rentalHeldNote(held: RentOwed | null): string {
  if (held?.kind === 'pack') {
    return ' Your pack session is held while Melanite reviews what happened.'
  }
  if (held?.kind === 'charged') {
    return ` The $${(held.cents / 100).toFixed(2)} rental fee is held while Melanite reviews what happened. You will hear once it has been looked at.`
  }
  if (held?.kind === 'due') {
    // Nothing has been taken, and this says so rather than implying a charge is sitting there.
    // Melanite may still decide the session is owed for — a slot nobody else could use — so it
    // must not read as "you are off the hook" either.
    //
    // NAMED FOR THE ARRANGEMENT. One of the grandfathered three is never charged a rental fee,
    // so calling it that would name a thing that does not exist for her; what is at stake is
    // Melanite's half of the session.
    const amount = `$${(held.cents / 100).toFixed(2)}`
    return held.split
      ? ` Nothing has been charged. Melanite reviews what happened and decides whether its ${amount} half of this session is still owed.`
      : ` The ${amount} rental fee has not been taken. Melanite reviews what happened and decides whether it is owed.`
  }
  return ''
}

export async function cancelBooking(
  bookingId: string,
  reason = '',
  chargeLateFee = false,
): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }

  // CANCELLING SOMETHING THAT HAS ALREADY FINISHED is not a cancellation, and until now nothing
  // stopped it — this checked the status and never the clock, while `markCompleted` and
  // `markNoShow` both refuse a session that has not started. The asymmetry mattered little when
  // a cancellation merely freed a slot. It matters now: the hour was taken off everybody else
  // and may already have been charged, and "Cancelled" on Keoni's queue reads as a session that
  // never happened when it may well have gone ahead.
  //
  // A session that is over has two honest endings, and both are already offered on the same row:
  // Completed, or No-show.
  if (booking.endTime <= new Date()) {
    return {
      error:
        'That appointment has already finished, so it cannot be cancelled. ' +
        'Mark it Completed, or a No-show if nobody came.',
    }
  }

  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be cancelled.' }
  }

  // Checked BEFORE anything is written. A cancellation that went through and then complained
  // about the reason would have freed the slot and taken the explanation with it.
  // Asked only inside the late window. `rentOwedFor` cannot answer this yet — it reads the
  // booking's status, and the booking is still `upcoming` for a few lines yet — so the same
  // question is put directly: how much notice is Melanite actually getting?
  //
  // Outside the window the slot goes back with time for somebody else to take it, nothing is
  // owed, and collecting a written reason would be paperwork about a non-event.
  const cancelSettings = await getCheckoutSettings()
  const hoursNotice = (booking.startTime.getTime() - Date.now()) / 3_600_000
  const isLate = hoursNotice < cancelSettings.lateCancellationHours

  const held = isLate ? await rentOwedFor(bookingId) : null
  const outcomeReason = reason.trim()

  if (held && outcomeReason.length < MIN_REASON) {
    return {
      error:
        'Tell Melanite what happened, in a sentence or so, before cancelling. ' +
        `Keoni reads these to decide whether the ${rentAmount(held)} rental fee is owed.`,
    }
  }

  const [live] = await db
    .select({ id: packageRedemptions.id })
    .from(packageRedemptions)
    .where(
      and(eq(packageRedemptions.bookingId, bookingId), isNull(packageRedemptions.voidedAt)),
    )
    .limit(1)

  if (live) {
    return {
      error:
        'This is a prepaid package session. Use "Cancel and restore session" so the client keeps it.',
    }
  }

  const [drawn] = await db
    .select({ id: prepaidRedemptions.id })
    .from(prepaidRedemptions)
    .where(
      and(eq(prepaidRedemptions.bookingId, bookingId), isNull(prepaidRedemptions.voidedAt)),
    )
    .limit(1)

  if (drawn) {
    return {
      error:
        'This appointment was paid from a prepaid balance. Use "Cancel and return the balance" so the client keeps their money.',
    }
  }

  await db
    .update(bookings)
    .set({
      status: 'cancelled',
      outcomeReason: outcomeReason || null,
      // Stamped so "was this late?" stays answerable afterwards. Without it the queue cannot
      // tell a cancellation made an hour before from one made a fortnight ahead.
      cancelledAt: new Date(),
    })
    .where(eq(bookings.id, bookingId))

  // Only a PENDING link is cancelled. A paid one is never silently voided — refunds are
  // handled in Stripe deliberately, so the record of payment has to survive the cancellation.
  await db
    .update(checkoutLinks)
    .set({ status: 'cancelled' })
    .where(and(eq(checkoutLinks.bookingId, bookingId), eq(checkoutLinks.status, 'pending')))

  revalidatePath('/app/appointments')

  // The slot goes back. The RENT DOES NOT — see `lib/rental/review.ts`. The appointment is
  // cancelled and the hour is bookable again within the same request; the money waits for
  // Keoni, because whether the provider owes it depends on something only she can judge.
  const rentNote = rentalHeldNote(held)

  // Before the fee branch, so the ordinary no-fee cancellation notifies too — that is the
  // common case and the one most likely to be forgotten.
  await notifyCancelled(bookingId, false)

  // The fee is opt-in per cancellation, never automatic. Charging a card without the provider
  // deciding to is not a default anyone should be able to stumble into.
  if (!chargeLateFee) return { success: `Appointment cancelled.${rentNote}` }

  const settings = await getCheckoutSettings()
  const hoursOut = (booking.startTime.getTime() - Date.now()) / 3_600_000
  if (hoursOut > settings.lateCancellationHours) {
    return {
      success: `Appointment cancelled.${rentNote}`,
      feeNote: `No fee charged — this was cancelled more than ${settings.lateCancellationHours} hours ahead.`,
    }
  }

  const fee = await chargeBookingFee(bookingId, 'late_cancellation_fee')
  if (fee.charged) {
    return {
      success: `Appointment cancelled.${rentNote} $${fee.amount} late cancellation fee charged.`,
    }
  }
  return { success: `Appointment cancelled.${rentNote}`, feeNote: fee.error ?? fee.skipped }
}

/** Cancel a package redemption and give the session back.
 *
 *  v1 runs this in a transaction: decrement qty_used (floored at 0), reactivate the package if
 *  it had been exhausted, stamp the redemption voided, then cancel the booking. All four have
 *  to happen together or a client silently loses a paid session.
 *
 *  Locked v1 decisions kept: always restore, with no cancellation-window cutoff; and an
 *  EXPIRED package gets its session back but stays expired.
 */
/** Tells the client their appointment is off, and Melanite that it happened.
 *
 *  The counterpart to the confirmation sent when a payment lands. Once somebody has been told
 *  an appointment exists they will act on it until told otherwise, so confirming without
 *  cancelling is worse than sending neither — it earns trust in a channel that then goes quiet
 *  at the one moment it matters.
 *
 *  Best effort, always after the cancellation is committed: a bounced email must never leave a
 *  client believing an appointment still stands.
 *
 *  Melanite's own alert is sent from HERE rather than from the three call sites, because this is
 *  already the one funnel all three cancellations pass through — and it goes out BEFORE the
 *  client lookup below, which returns early on a booking with no email address on it. A walk-in
 *  with no address still frees the laser, and that is the fact Keoni is being told.
 */
async function notifyCancelled(
  bookingId: string,
  returned: false | 'package' | 'prepaid',
): Promise<void> {
  await notifyMelaniteCancelled(bookingId)

  try {
    const [row] = await db
      .select({
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        startTime: bookings.startTime,
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

    if (!row?.clientEmail) return

    await sendEmail({
      to: row.clientEmail,
      ...bookingCancelledEmail({
        clientName: clientLabel(row.clientName),
        providerName: `${row.providerFirst} ${row.providerLast}`,
        serviceName: row.serviceName,
        when: appointmentWhen(row.startTime),
        returned,
      }),
    })
  } catch (err) {
    console.error('[email] cancellation notice failed for booking', bookingId, err)
  }
}

/** Mark a past appointment as a no-show.
 *
 *  Status label only — v1 charges no fee here, and that decision is deliberate rather than
 *  unfinished. The booking must already be in the past; labelling a future appointment a
 *  no-show is always a mistake.
 */
export async function markNoShow(
  bookingId: string,
  reason = '',
  chargeFee = false,
): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be marked as a no-show.' }
  }
  if (booking.startTime > new Date()) {
    return { error: "That appointment hasn't happened yet." }
  }

  const held = await rentOwedFor(bookingId)
  const outcomeReason = reason.trim()

  if (held && outcomeReason.length < MIN_REASON) {
    return {
      error:
        'Tell Melanite what happened, in a sentence or so, before marking this a no-show. ' +
        'Keoni reads these to decide whether the rental fee stands.',
    }
  }

  await db
    .update(bookings)
    .set({ status: 'no_show', outcomeReason: outcomeReason || null })
    .where(eq(bookings.id, bookingId))

  revalidatePath('/app/appointments')

  // This USED TO REFUND, on the rule that a provider does not owe the fee when their client
  // fails to turn up. Keoni withdrew that on 7 October: a no-show is only the client's fault
  // when it actually is, and the software was taking the provider's word for it by refunding
  // without anybody reading a word. It is reviewed now, like a cancellation.
  const rentNote = rentalHeldNote(held)

  // And it is told about now, for the same reason. A no-show needed no alert while it settled
  // itself; one that holds a provider's money until somebody acts needs the prompt that makes
  // somebody act.
  if (held) await notifyMelaniteNoShow(bookingId)

  if (!chargeFee) return { success: `Marked as a no-show.${rentNote}` }

  const fee = await chargeBookingFee(bookingId, 'no_show_fee')
  if (fee.charged) {
    return { success: `Marked as a no-show.${rentNote} $${fee.amount} fee charged.` }
  }
  return { success: `Marked as a no-show.${rentNote}`, feeNote: fee.error ?? fee.skipped }
}

/** Mark a past appointment as completed. v1 had no such endpoint — bookings simply stayed
 *  `upcoming` forever, which is a large part of why stale appointments accumulate.
 *
 *  IT RECORDS THAT THE TREATMENT HAPPENED. Nothing more, and deliberately so.
 *
 *  It used to do more than that by accident: `getCheckoutByToken` refused to let anything that
 *  was not `upcoming` be paid, so pressing this on an unpaid appointment quietly locked the
 *  client out of paying — by link and by the emailed link alike — and the page told them to
 *  contact their provider, who had just caused it. A provider pressing "Completed" is saying
 *  she did the work, which is the moment the money is MOST owed, not least.
 *
 *  Availability, earnings and the calendar all treat `upcoming` and `completed` the same. That
 *  is the intended shape: this is a record, and nothing should hang consequences off it without
 *  saying so here. */
export async function markCompleted(bookingId: string): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') return { error: 'That appointment is already resolved.' }
  if (booking.startTime > new Date()) {
    return { error: "That appointment hasn't happened yet." }
  }

  await db.update(bookings).set({ status: 'completed' }).where(eq(bookings.id, bookingId))

  revalidatePath('/app/appointments')
  return { success: 'Marked as completed.' }
}
