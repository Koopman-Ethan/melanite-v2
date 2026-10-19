'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { putReceipt } from '@/lib/blob'
import { db } from '@/lib/db'
import { bookings, providers } from '@/lib/db/schema'
import { recordReceipt, type ReceiptState } from '@/lib/rental/receipts'
import { toCents } from '@/lib/money'

// Sending Keoni the receipt for what a session was worth.
//
// Only a `keoni_sets` provider has anything to send: everybody else is charged the published
// fee and Melanite needs no input from them. Refusing here rather than hiding the form is the
// usual rule — the UI decides what to show, the server decides what is allowed.

export async function submitReceipt(
  _prev: ReceiptState,
  formData: FormData,
): Promise<ReceiptState> {
  const user = await requireProvider()

  const [me] = await db
    .select({ rentBasis: providers.rentBasis })
    .from(providers)
    .where(eq(providers.id, user.id))
    .limit(1)

  if (me?.rentBasis !== 'keoni_sets') {
    return { error: 'Your rental fee comes from the published schedule — there is nothing to send.' }
  }

  const bookingId = String(formData.get('bookingId') ?? '')
  const amount = Number(formData.get('amount') ?? '')

  if (!bookingId) return { error: 'Which appointment?' }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Enter what you charged your client.' }
  }

  // The booking must be theirs AND finished. A receipt for a session that has not happened is
  // either a mistake or an attempt to get a figure set early, and neither should be recorded.
  const [booking] = await db
    .select({ id: bookings.id, endTime: bookings.endTime })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)

  if (!booking) return { error: 'That appointment does not exist.' }
  if (booking.endTime > new Date()) {
    return { error: 'That session has not finished yet.' }
  }

  // The file is optional — see `recordReceipt`. A bad signal in a treatment room must not stop
  // them telling Melanite the number.
  const file = formData.get('receipt')
  let stored: { storageKey: string; mimeType: string } | null = null

  if (file instanceof File && file.size > 0) {
    const result = await putReceipt(bookingId, file)
    if (!result.ok) return { error: result.detail }
    stored = { storageKey: result.blob.storageKey, mimeType: result.blob.mimeType }
  }

  const out = await recordReceipt({
    bookingId,
    providerId: user.id,
    amountCents: toCents(amount),
    stored,
  })

  revalidatePath('/app/appointments')
  revalidatePath('/app/admin/queue')
  return out
}
