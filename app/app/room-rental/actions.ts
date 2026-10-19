'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { isExclusionViolation } from '@/lib/db/errors'
import {
  getRoomSettings,
  releaseExpiredHolds,
  slotBounds,
  slotPrice,
  type SlotType,
} from '@/lib/db/queries/room-rental'
import { providers, roomBookings } from '@/lib/db/schema'
import { ROOM_SLOT_LABELS } from '@/lib/email'
import { notifyMelaniteRoomRental } from '@/lib/notify-melanite'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'
import { getProcessingRate } from '@/lib/db/queries/admin-tools'
import { grossUpForProcessing, toCents } from '@/lib/money'

export interface RentalState {
  error?: string
  success?: string
}

/** How long a slot is held between reserving it and the charge landing.
 *
 *  It used to cover somebody standing in Stripe Checkout typing a card. The charge is taken
 *  against the card on file now and resolves in a second or two, so the hold only has to
 *  outlive a slow network and the release in the catch below. Left at thirty minutes anyway:
 *  the cost of a hold that is too long is a room unavailable for a while, and the cost of one
 *  too short is a provider charged for a slot somebody else has taken. */
const HOLD_MINUTES = 30

const SLOTS = new Set<SlotType>(['full', 'am', 'pm'])

/** Reserve a slot, then send the provider to Stripe Checkout.
 *
 *  v1 did the reverse: it checked availability with a read, created no row, and let the webhook
 *  be "the atomic commit". Between that read and the webhook nothing held the slot, so two
 *  providers could both pay for the same day and one of them had to be refunded by hand.
 *
 *  Here the row is written first and `room_bookings_no_overlap` decides. A conflict surfaces as
 *  a constraint violation, which is the only answer that cannot be raced.
 */
export async function startRoomRental(input: {
  rentalDate: string
  slotType: SlotType
}): Promise<RentalState> {
  const user = await requireProvider()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.rentalDate)) return { error: 'Pick a date.' }
  if (!SLOTS.has(input.slotType)) return { error: 'Pick a block.' }

  const settings = await getRoomSettings()
  if (!settings.enabled) {
    return { error: 'Room rental is not currently available. Contact Melanite.' }
  }

  // Deliberately NOT the full booking gate. Renting the room is a space rental; the medical
  // director and license gates govern treating on the laser, and v1 drew the same line.
  if (!user.bookingEnabled) {
    return { error: 'Your account is not yet cleared. Melanite will enable it once your documents are confirmed.' }
  }
  if (!user.roomRentalEnabled) {
    return { error: 'Room rental is not available on your account. Contact Melanite.' }
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date())
  if (input.rentalDate < today) return { error: 'That date has already passed.' }

  const horizon = new Date()
  horizon.setDate(horizon.getDate() + settings.advanceDays)
  const lastBookable = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(
    horizon,
  )
  if (input.rentalDate > lastBookable) {
    return { error: `The room can be booked up to ${settings.advanceDays} days ahead.` }
  }

  if (!stripeWritesEnabled()) {
    return { error: 'Payments are not configured in this environment.' }
  }

  await releaseExpiredHolds()

  const { startAt, endAt } = slotBounds(input.rentalDate, input.slotType, settings)
  const price = slotPrice(input.slotType, settings)

  let holdId: string
  try {
    const [held] = await db
      .insert(roomBookings)
      .values({
        providerId: user.id,
        rentalDate: input.rentalDate,
        slotType: input.slotType,
        price,
        status: 'pending',
        startAt,
        endAt,
        holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),
      })
      .returning({ id: roomBookings.id })
    holdId = held.id
  } catch (err) {
    // 23P01 is exclusion_violation — someone holds an overlapping block. This is the expected
    // outcome of a race, not an error to log and forget.
    if (isExclusionViolation(err)) {
      return { error: 'That block was just taken. Pick another.' }
    }
    throw err
  }

  // THE CARD ON FILE, not a checkout redirect.
  //
  // Every provider carries one now — it is what pays the rental fee — so sending them to
  // Stripe to type a card they have already given is a round trip for nothing. It also means
  // one card per provider rather than whichever was nearest at the time, which is what Keoni
  // actually wants to be chasing when something declines.
  //
  // NEVER CONNECT. This is money coming IN from a provider; Connect pays providers OUT and has
  // no part in it. It never did here, and saying so stops anybody adding `transfer_data` on the
  // assumption that every Stripe call in this codebase needs it.
  const [payer] = await db
    .select({
      customerId: providers.stripeBillingCustomerId,
      paymentMethodId: providers.billingPaymentMethodId,
    })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (!payer?.customerId || !payer?.paymentMethodId) {
    await releaseHold(holdId)
    return {
      error: 'Add a card on your account page before booking the room.',
    }
  }

  // Priced the same way laser time is: the figure Keoni set is what Melanite KEEPS, and
  // processing goes on top. Charging $100 and banking $96.80 is the thing this whole
  // arrangement exists to stop.
  const processing = await getProcessingRate()
  const { chargeCents } = grossUpForProcessing({
    netCents: toCents(price),
    pct: processing.pct,
    fixedCents: processing.fixedCents,
  })

  try {
    await stripePost<{ id: string; status: string }>(
      '/payment_intents',
      {
        amount: chargeCents,
        currency: 'usd',
        customer: payer.customerId,
        payment_method: payer.paymentMethodId,
        // Nobody is watching for a 3DS challenge — they pressed a button in the app, not a
        // checkout. A card that insists on one declines, which is the right outcome.
        off_session: true,
        confirm: true,
        description: roomLineItemName(input.rentalDate, input.slotType),
        metadata: {
          type: 'room_rental',
          provider_id: user.id,
          rental_date: input.rentalDate,
          slot_type: input.slotType,
          room_booking_id: holdId,
        },
      },
      {
        // The hold id, as before: a double submit cannot take the room twice.
        idempotencyKey: `room-rental:${holdId}`,
      },
    )
  } catch (err) {
    // Releasing the hold matters: leaving it would block the room for HOLD_MINUTES over a
    // payment that never happened.
    await releaseHold(holdId)
    return {
      error: friendlyStripeError(
        err,
        'That card was declined. Update it on your account page and try again.',
      ),
    }
  }

  // The booking is confirmed and its ledger row written by `roomRentalPaid`, from the webhook,
  // exactly as before — this only changed how the money is taken. The handler is guarded by
  // `alreadyRecorded`, so the charge arriving twice cannot bank it twice.
  revalidatePath('/app/room-rental')
  return { success: `Room booked. ${usdLabel(chargeCents)} charged to your card.` }
}

/** Frees a slot whose payment did not happen. */
async function releaseHold(holdId: string): Promise<void> {
  await db
    .update(roomBookings)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(roomBookings.id, holdId))
}

const usdLabel = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** Cancel a rental.
 *
 *  More than 24h out, v1 refunded automatically; inside 24h it flagged the row for Keoni to
 *  decide. Both free the slot immediately either way — the room being unusable while a refund
 *  is argued about helps nobody.
 *
 *  Deliberately not gated on `roomRentalEnabled`: turning the feature off must never strand a
 *  provider with a booking they cannot cancel.
 */
export async function cancelRoomRental(rentalId: string): Promise<RentalState> {
  const user = await requireProvider()

  const [rental] = await db
    .select({
      id: roomBookings.id,
      status: roomBookings.status,
      startAt: roomBookings.startAt,
      price: roomBookings.price,
      paymentIntentId: roomBookings.stripePaymentIntentId,
    })
    .from(roomBookings)
    .where(and(eq(roomBookings.id, rentalId), eq(roomBookings.providerId, user.id)))
    .limit(1)

  if (!rental) return { error: 'That rental does not exist.' }
  if (rental.status !== 'confirmed') {
    return { error: 'Only confirmed rentals can be cancelled.' }
  }

  const hoursOut = (rental.startAt.getTime() - Date.now()) / 3_600_000

  if (hoursOut <= 24) {
    await db
      .update(roomBookings)
      .set({ status: 'cancellation_requested', cancelledAt: new Date() })
      .where(eq(roomBookings.id, rental.id))

    // The alert says the refund is hers to decide, because it is — this row is now sitting in
    // the admin queue waiting for it.
    await notifyMelaniteRoomRental(rental.id, 'cancelled', { awaitingRefundDecision: true })

    revalidatePath('/app/room-rental')
    return {
      success:
        'Cancelled. Because it is within 24 hours, Melanite will review the refund — the block is free either way.',
    }
  }

  if (!rental.paymentIntentId || !stripeWritesEnabled()) {
    // No payment to reverse, or no write key here. Free the block and let a human settle it
    // rather than refusing the cancellation.
    await db
      .update(roomBookings)
      .set({ status: 'cancellation_requested', cancelledAt: new Date() })
      .where(eq(roomBookings.id, rental.id))

    await notifyMelaniteRoomRental(rental.id, 'cancelled', { awaitingRefundDecision: true })

    revalidatePath('/app/room-rental')
    return { success: 'Cancelled. Melanite will confirm the refund separately.' }
  }

  try {
    await stripePost(
      '/refunds',
      {
        payment_intent: rental.paymentIntentId,
        metadata: { reason: 'room_rental_self_cancel_over_24h' },
      },
      { idempotencyKey: `room-refund:${rental.id}` },
    )
  } catch (err) {
    return { error: friendlyStripeError(err, 'The refund could not be processed. Contact Melanite.') }
  }

  // The refund's own webhook writes the ledger entry and flips this to `refunded`; marking it
  // cancelled here frees the block without waiting for Stripe to call back.
  await db
    .update(roomBookings)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(roomBookings.id, rental.id))

  await notifyMelaniteRoomRental(rental.id, 'cancelled')

  revalidatePath('/app/room-rental')
  return { success: `Cancelled and refunded $${Number(rental.price).toFixed(2)}.` }
}


function roomLineItemName(date: string, slot: SlotType): string {
  const [y, m, d] = date.split('-').map(Number)
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return `Room rental — ${ROOM_SLOT_LABELS[slot]}, ${label}`
}
