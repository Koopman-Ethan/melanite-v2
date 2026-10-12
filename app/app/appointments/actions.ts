'use server'

import { and, eq, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { rentOwedFor, type RentOwed } from '@/lib/rental/review'

import { clientLabel } from '@/lib/booking-labels'
import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { getCheckoutSettings } from '@/lib/db/queries/checkout'
import {
  bookings,
  checkoutLinks,
  clientPackageItems,
  clientPackages,
  packageRedemptions,
  prepaidBalances,
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
  const held = await rentOwedFor(bookingId)
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
    .set({ status: 'cancelled', outcomeReason: outcomeReason || null })
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

export async function cancelPackageRedemption(bookingId: string): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be cancelled.' }
  }

  const [redemption] = await db
    .select({
      id: packageRedemptions.id,
      itemId: packageRedemptions.clientPackageItemId,
      packageId: packageRedemptions.clientPackageId,
      packageProviderId: clientPackages.providerId,
      packageStatus: clientPackages.status,
    })
    .from(packageRedemptions)
    .innerJoin(clientPackages, eq(packageRedemptions.clientPackageId, clientPackages.id))
    .where(
      and(eq(packageRedemptions.bookingId, bookingId), isNull(packageRedemptions.voidedAt)),
    )
    .limit(1)

  if (!redemption) return { error: 'This appointment is not a package session.' }
  if (redemption.packageProviderId !== user.id) {
    return { error: 'That package belongs to another provider.' }
  }

  // One statement, not a transaction.
  //
  // This was `db.transaction(async tx => …)`, which the neon-http driver does not implement —
  // it throws "No transactions support in neon-http driver" before touching anything. So this
  // path had never once run: cancelling a package session reported success and returned
  // nothing, which is precisely the outcome the whole feature exists to prevent.
  //
  // A single statement with CTEs is atomic in Postgres and needs no interactive transaction.
  // The ordering is deliberate: `voided` is the gate, and everything downstream reads from it,
  // so if the redemption was already voided nothing else fires.
  //
  // `voided_at is null` is what makes a second click harmless. Without it, cancelling twice
  // would hand back two sessions for one appointment — a package that grows when you poke it.
  const undone = await db.execute(sql`
    WITH voided AS (
      UPDATE package_redemptions SET voided_at = now()
       WHERE id = ${redemption.id}::uuid AND voided_at IS NULL
      RETURNING client_package_item_id, client_package_id
    ),
    restored AS (
      -- greatest(...) rather than read-modify-write, so concurrent cancellations cannot drive
      -- the count below zero.
      UPDATE client_package_items
         SET qty_used = greatest(qty_used - 1, 0)
       WHERE id = (SELECT client_package_item_id FROM voided)
      RETURNING id
    ),
    reopened AS (
      -- Exhausted becomes usable again now a session is back. Expired deliberately stays
      -- expired: the session returns, the expiry still stands.
      UPDATE client_packages SET status = 'active'
       WHERE id = (SELECT client_package_id FROM voided) AND status = 'exhausted'
      RETURNING id
    )
    UPDATE bookings SET status = 'cancelled'
     WHERE id = ${bookingId}::uuid
       AND EXISTS (SELECT 1 FROM voided)
    RETURNING id
  `)

  if ((undone.rows?.length ?? 0) === 0) {
    // The redemption was voided by someone else between the read above and this write.
    return { error: 'That session was already returned. Refresh to see the current state.' }
  }

  // Saying which is the difference between "your appointment is cancelled" and "your
  // appointment is cancelled and you have lost $200".
  await notifyCancelled(bookingId, 'package')

  revalidatePath('/app/appointments')
  // And the page that shows the count this just changed. Returning a session is the whole
  // point of this action, and the balance it returns to is rendered somewhere else — without
  // this the provider cancels, goes to look, and sees the session still gone.
  revalidatePath('/app/packages')
  return { success: 'Appointment cancelled and the session returned to the package.' }
}

/** Cancel an appointment that drew on a prepaid balance, putting the money back.
 *
 *  The counterpart of `cancelPackageRedemption`, and the same single-CTE shape for the same
 *  reason: the neon-http driver has no interactive transactions, so anything spanning several
 *  writes has to be one statement or it is not atomic at all.
 *
 *  One difference that matters. A package session is always one row; a prepaid booking can draw
 *  on SEVERAL balances at once, because oldest-first spending lets a $220 service take $50 off
 *  one and $170 off the next. So `voided` returns a set, and the restore joins against it rather
 *  than reading a single id. Getting this wrong would return one balance and quietly keep the
 *  rest of the client's money.
 */
export async function cancelPrepaidBooking(bookingId: string): Promise<ActionState> {
  const user = await requireProvider()

  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'Appointment not found.' }
  if (booking.status !== 'upcoming') {
    return { error: 'Only upcoming appointments can be cancelled.' }
  }

  const [drawn] = await db
    .select({ id: prepaidRedemptions.id, balanceId: prepaidRedemptions.prepaidBalanceId })
    .from(prepaidRedemptions)
    .innerJoin(prepaidBalances, eq(prepaidRedemptions.prepaidBalanceId, prepaidBalances.id))
    .where(
      and(
        eq(prepaidRedemptions.bookingId, bookingId),
        isNull(prepaidRedemptions.voidedAt),
        eq(prepaidBalances.providerId, user.id),
      ),
    )
    .limit(1)

  if (!drawn) return { error: 'This appointment did not draw on a prepaid balance.' }

  // `voided_at IS NULL` is what makes a second click harmless. Without it, cancelling twice
  // would hand the money back twice — a balance that grows when you poke it.
  //
  // No clamp on the way back up. The amount returned is exactly what was taken, so exceeding
  // the original is arithmetically impossible; if it ever happens the check constraint should
  // say so loudly rather than a `least()` silently absorbing it.
  const undone = await db.execute(sql`
    WITH voided AS (
      UPDATE prepaid_redemptions SET voided_at = now()
       WHERE booking_id = ${bookingId}::uuid AND voided_at IS NULL
      RETURNING prepaid_balance_id, amount_applied
    ),
    restored AS (
      UPDATE prepaid_balances b
         SET remaining_amount = b.remaining_amount + v.amount_applied,
             -- Exhausted becomes spendable again now the money is back. There is no expiry to
             -- respect, so unlike a package this always reopens.
             status = 'active'
        FROM voided v
       WHERE b.id = v.prepaid_balance_id
      RETURNING b.id
    ),
    unlinked AS (
      -- Any pending link for the remainder goes with it. A paid one is left alone: refunds are
      -- deliberately a Stripe decision, so the record of payment must survive the cancellation.
      UPDATE checkout_links SET status = 'cancelled'
       WHERE booking_id = ${bookingId}::uuid AND status = 'pending'
         AND EXISTS (SELECT 1 FROM voided)
      RETURNING id
    )
    UPDATE bookings SET status = 'cancelled'
     WHERE id = ${bookingId}::uuid
       AND EXISTS (SELECT 1 FROM voided)
    RETURNING id
  `)

  if ((undone.rows?.length ?? 0) === 0) {
    return { error: 'That balance was already returned. Refresh to see the current state.' }
  }

  // The money went back, and the client needs to be told so — otherwise this reads as a
  // cancellation that cost them the balance.
  await notifyCancelled(bookingId, 'prepaid')

  revalidatePath('/app/appointments')
  revalidatePath('/app/prepaid')
  return { success: 'Appointment cancelled and the money returned to their balance.' }
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
