'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import {
  getRoomSettings,
  releaseExpiredHolds,
  slotBounds,
  slotPrice,
  type SlotType,
} from '@/lib/db/queries/room-rental'
import { roomBookings } from '@/lib/db/schema'
import { appOrigin } from '@/lib/stripe/config'
import { friendlyStripeError, stripePost, stripeWritesEnabled } from '@/lib/stripe/client'

export interface RentalState {
  error?: string
  url?: string
  success?: string
}

/** How long a slot is held while the provider is in Stripe Checkout. Long enough to finish
 *  paying, short enough that an abandoned checkout does not take the room off the market for
 *  the rest of the day. Stripe Checkout sessions expire at 24h; this is the tighter bound. */
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
  // director and licence gates govern treating on the laser, and v1 drew the same line.
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

  const base = await appOrigin()
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

  try {
    const session = await stripePost<{ id: string; url?: string }>(
      '/checkout/sessions',
      {
        mode: 'payment',
        success_url: `${base}/app/room-rental?paid=1`,
        cancel_url: `${base}/app/room-rental?cancelled=1`,
        client_reference_id: holdId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(Number(price) * 100),
              product_data: { name: roomLineItemName(input.rentalDate, input.slotType) },
            },
          },
        ],
        // On the PaymentIntent, not just the session: the webhook routes on
        // payment_intent.succeeded, and session metadata does not reach it.
        payment_intent_data: {
          metadata: {
            type: 'room_rental',
            provider_id: user.id,
            rental_date: input.rentalDate,
            slot_type: input.slotType,
            room_booking_id: holdId,
          },
        },
        metadata: { type: 'room_rental', room_booking_id: holdId },
      },
      {
        // The hold id is the natural idempotency key: a double-submit reuses the same checkout
        // rather than opening a second one against the same reserved slot.
        idempotencyKey: `room-rental:${holdId}`,
      },
    )

    await db
      .update(roomBookings)
      .set({ stripeCheckoutSessionId: session.id })
      .where(eq(roomBookings.id, holdId))

    if (!session.url) throw new Error('Stripe did not return a checkout URL.')

    revalidatePath('/app/room-rental')
    return { url: session.url }
  } catch (err) {
    // Releasing the hold matters: leaving it would block the room for HOLD_MINUTES over a
    // checkout that never existed.
    await db
      .update(roomBookings)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(roomBookings.id, holdId))

    return { error: friendlyStripeError(err, 'Could not start the payment. Try again shortly.') }
  }
}

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

  revalidatePath('/app/room-rental')
  return { success: `Cancelled and refunded $${Number(rental.price).toFixed(2)}.` }
}

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ('code' in err
      ? (err as { code?: string }).code === '23P01'
      : String((err as { message?: string }).message ?? '').includes('room_bookings_no_overlap'))
  )
}

const SLOT_LABELS: Record<SlotType, string> = {
  full: 'Full day',
  am: 'Morning',
  pm: 'Afternoon',
}

function roomLineItemName(date: string, slot: SlotType): string {
  const [y, m, d] = date.split('-').map(Number)
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return `Room rental — ${SLOT_LABELS[slot]}, ${label}`
}
