import 'server-only'

import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { deleteReceipt } from '@/lib/blob'
import { db } from '@/lib/db'
import { bookings } from '@/lib/db/schema'

// What a `keoni_sets` provider tells Melanite they charged their client, and what becomes of it.
//
// Melanite works out no fee for those three. Keoni needs an input before she can set one, and
// this is it: an AMOUNT, which is required, plus a receipt backing it, which is evidence.
//
// THE ORDER MATTERS. A file-only version would mean opening a photograph of somebody's receipt
// to answer every single session — three a week, for ever. With the amount on the queue item
// she reads a number and charges it, and opens the document only when it looks wrong. That is
// also what keeps the client data exposure down, which is the other half of this module.
//
// RETENTION. The rental terms say in as many words that Melanite keeps no record of who a
// provider's clients are, and a receipt is very likely to name one. So the document does not
// live on the booking indefinitely: `forgetReceipt` removes it the moment Keoni charges or
// waives the session, because by then it has done its only job. The amount and the timestamp
// survive, which still answers "was there a receipt, and what did it say" — that is a fact
// about the provider, not about their client.

export interface ReceiptState {
  error?: string
  success?: string
}

/** Receipts above this are a typo rather than a treatment. The same ceiling the queue uses for
 *  Keoni's own figure, and for the same reason: a slipped decimal point on a real card. */
const MAX_CENTS = 500_000

/**
 * Records what they charged, against a booking that is theirs.
 *
 * The file is OPTIONAL and the amount is not. A provider who has the number to hand but cannot
 * get a photo to upload on a bad signal should not be blocked from telling Melanite — the
 * queue item shows Keoni whether a document came with it, and she can ask.
 */
export async function recordReceipt(input: {
  bookingId: string
  providerId: string
  amountCents: number
  stored: { storageKey: string; mimeType: string } | null
}): Promise<ReceiptState> {
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    return { error: 'Enter what you charged your client.' }
  }
  if (input.amountCents > MAX_CENTS) {
    return { error: 'That is more than $5,000. Check the figure.' }
  }

  // Scoped to the provider in the WHERE clause rather than checked and then written. The caller
  // has already established who is signed in; this makes it impossible for a mismatched id to
  // write to somebody else's booking even if that check were ever dropped.
  const updated = await db
    .update(bookings)
    .set({
      receiptAmountCents: input.amountCents,
      receiptUploadedAt: new Date(),
      ...(input.stored
        ? {
            receiptStorageKey: input.stored.storageKey,
            receiptMimeType: input.stored.mimeType,
            // Re-sending after a deletion makes it present again; the old stamp would say
            // otherwise and the queue would hide a document that is really there.
            receiptDeletedAt: null,
          }
        : {}),
    })
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.providerId, input.providerId)))
    .returning({ id: bookings.id })

  if (updated.length === 0) return { error: 'That appointment is not yours, or does not exist.' }

  return {
    success: input.stored
      ? 'Sent. Keoni sets what you owe from this.'
      : 'Sent. Keoni sets what you owe from this — add the receipt itself when you can.',
  }
}

/**
 * Removes the document once the session has been settled, keeping the fact of it.
 *
 * Called after Keoni charges or waives. BEST EFFORT AND NEVER THROWS: a receipt the store would
 * not delete is untidy, whereas a charge that failed because a cleanup failed is somebody's
 * money. The row is stamped either way, so a straggler in the store is findable later and the
 * booking never claims to be holding a document it is not.
 */
export async function forgetReceipt(bookingId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ storageKey: bookings.receiptStorageKey })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1)

    if (!row?.storageKey) return

    await deleteReceipt(row.storageKey)

    await db
      .update(bookings)
      .set({ receiptStorageKey: null, receiptMimeType: null, receiptDeletedAt: new Date() })
      .where(eq(bookings.id, bookingId))
  } catch (err) {
    console.error('[receipt] could not forget receipt for booking', bookingId, err)
  }
}

/**
 * Receipts still held for sessions that have already been settled.
 *
 * The backstop for `forgetReceipt` failing — a store timeout, or a settlement that happened
 * before this module existed. Nothing calls it on a schedule yet; it is here so that "are we
 * holding documents we promised not to keep" is a question with an answer rather than an
 * assumption, and so the sweep that answers it has somewhere obvious to live.
 */
export async function receiptsHeldAfterSettlement(): Promise<string[]> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        isNotNull(bookings.receiptStorageKey),
        isNull(bookings.receiptDeletedAt),
        // Settled means Keoni has acted: a figure set and charged, or waived outright.
        isNotNull(bookings.rentWaivedAt),
      ),
    )

  return rows.map((r) => r.id)
}
