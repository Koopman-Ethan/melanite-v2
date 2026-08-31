'use server'

import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { deleteEquipmentPhoto, putEquipmentPhoto } from '@/lib/blob'
import { db } from '@/lib/db'
import { bookings, equipmentChecks, providers } from '@/lib/db/schema'
import { EQUIPMENT_POLICY_VERSION } from '@/lib/equipment-policy'
import { notifyEquipmentFlagged } from '@/lib/notify-melanite'

// Recording a photograph of the laser.
//
// The photo arrives through a server action rather than a direct-to-blob upload because the
// client downscales it first — a 1600px JPEG lands around 200–400KB, comfortably inside the body
// limit, and routing it through here means the ownership check and the storage write cannot come
// apart. If photos ever get bigger than a downscaled phone snap, this is the thing to revisit.

export interface CheckState {
  error?: string
  success?: string
}

export async function recordEquipmentCheck(
  _prev: CheckState,
  formData: FormData,
): Promise<CheckState> {
  const user = await requireProvider()

  const bookingId = String(formData.get('bookingId') ?? '')
  const kind = String(formData.get('kind') ?? '')
  const note = String(formData.get('note') ?? '').trim() || null
  const needsAttention = formData.get('needsAttention') === 'on'
  const photo = formData.get('photo')

  if (kind !== 'before' && kind !== 'after') {
    return { error: 'That is not a kind of check.' }
  }

  // Ownership is part of the query, not a check afterwards — the same shape every other action
  // here uses. A provider may only photograph the laser against their OWN session, because the
  // whole record is an attribution and one written against somebody else's booking is a lie.
  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'That appointment is not yours.' }
  if (booking.status === 'cancelled' || booking.status === 'no_show') {
    // Nobody touched the laser, so there is nothing to account for and a photo here would only
    // muddy the record.
    return { error: 'That appointment did not happen, so there is nothing to photograph for it.' }
  }

  if (!(photo instanceof File)) return { error: 'Choose a photo of the laser.' }

  // The id is generated first so it can name the object. Nothing is written to storage until the
  // file has passed validation — v1 persisted first and validated second, so every refused upload
  // was already sitting in the bucket.
  const checkId = randomUUID()
  const stored = await putEquipmentPhoto(checkId, photo)

  if (!stored.ok) return { error: stored.detail }

  try {
    await db.insert(equipmentChecks).values({
      id: checkId,
      bookingId: booking.id,
      providerId: user.id,
      kind,
      storageKey: stored.blob.storageKey,
      mimeType: stored.blob.mimeType,
      sizeBytes: stored.blob.sizeBytes,
      note,
      needsAttention,
    })
  } catch (err) {
    // The row is the only pointer to the object. Without this the photo is unreachable for ever
    // and counts against storage anyway.
    await deleteEquipmentPhoto(stored.blob.storageKey)
    throw err
  }

  revalidatePath('/app/appointments')
  revalidatePath('/app/dashboard')

  // Best effort, after the record exists — a notification that fails must never lose the
  // photograph it was describing.
  if (needsAttention) await notifyEquipmentFlagged(checkId)

  return {
    success: needsAttention
      ? 'Photo saved and Melanite has been told.'
      : kind === 'before'
        ? 'Photo saved. You are covered for this session.'
        : 'Photo saved.',
  }
}

/** Accept the current equipment policy. Stamped with the version so a later rewording asks
 *  again rather than inheriting an agreement to words nobody saw. */
export async function acceptEquipmentPolicy(): Promise<{ error?: string }> {
  const user = await requireProvider()

  await db
    .update(providers)
    .set({
      equipmentPolicyAckAt: new Date(),
      equipmentPolicyAckVersion: EQUIPMENT_POLICY_VERSION,
    })
    .where(eq(providers.id, user.id))

  revalidatePath('/app/book')
  return {}
}
