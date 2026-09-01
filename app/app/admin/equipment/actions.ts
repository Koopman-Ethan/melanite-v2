'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { deleteEquipmentPhoto } from '@/lib/blob'
import { db } from '@/lib/db'
import { equipmentChecks } from '@/lib/db/schema'

export interface RemovePhotoState {
  error?: string
  success?: string
}

/**
 * Destroys a photograph while keeping the record that it was taken.
 *
 * This exists for removing what should never have been stored — a client caught in frame is
 * health information sitting in a store built for a machine, and Melanite should not have to ask
 * a developer to get rid of it. It is NOT a housekeeping tool: photographs accumulate at about
 * half a gigabyte a year, so space is not a reason to delete anything.
 *
 * THE ROW SURVIVES. Every query that asks whether a session was accounted for asks whether a
 * check row exists — `getUnbracketedSessions` does exactly that with a `not exists`. Deleting the
 * row would quietly convert a provider who photographed the laser into one who did not, months
 * after the fact and with no way to tell. The bytes are the only thing that goes.
 *
 * `requireAdmin()`, matching every other destructive admin surface. A provider cannot remove her
 * own photograph: the record exists precisely so that the person it describes cannot edit it.
 */
export async function removeEquipmentPhoto(input: {
  checkId: string
  reason?: string
}): Promise<RemovePhotoState> {
  const admin = await requireAdmin()

  const [check] = await db
    .select({
      id: equipmentChecks.id,
      storageKey: equipmentChecks.storageKey,
      deletedAt: equipmentChecks.photoDeletedAt,
    })
    .from(equipmentChecks)
    .where(eq(equipmentChecks.id, input.checkId))
    .limit(1)

  if (!check) return { error: 'That photo is not here any more.' }
  if (check.deletedAt) return { success: 'That photo was already removed.' }

  // Storage first. If it fails, nothing is written — a row marked deleted while the file is still
  // sitting in the bucket is the one outcome worse than not deleting at all, because the page
  // would then say the photograph is gone when it is not.
  const removed = await deleteEquipmentPhoto(check.storageKey)
  if (!removed.ok) return { error: removed.detail }

  const reason = input.reason?.trim()
  await db
    .update(equipmentChecks)
    .set({
      photoDeletedAt: new Date(),
      photoDeletedBy: admin.id,
      photoDeletedReason: reason && reason.length > 0 ? reason.slice(0, 300) : null,
    })
    .where(eq(equipmentChecks.id, input.checkId))

  revalidatePath('/app/admin/equipment')
  revalidatePath('/app/appointments')

  return { success: 'Photo removed. The record that it was taken stays.' }
}
