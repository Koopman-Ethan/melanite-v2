'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { deleteEquipmentPhoto } from '@/lib/blob'
import { db } from '@/lib/db'
import { endOfUseChecklists } from '@/lib/db/schema'

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
 * THE ROW SURVIVES, and the bytes are the only thing that goes. `getSessionsWithoutCloseout` asks
 * whether a close-out row exists; deleting one would quietly convert a provider who signed off
 * into one who never did, months later and with no way to tell. It would also destroy the fault
 * they reported, which is the part Melanite actually needs.
 *
 * `photo_deleted_at` is deliberately outside the `end_of_use_issue_photo` constraint for the same
 * reason: removing the image must not make the row that describes the fault invalid.
 *
 * `requireAdmin()`, matching every other destructive admin surface. A provider cannot remove her
 * own photograph: the record exists precisely so that the person it describes cannot edit it.
 */
export async function removeEquipmentPhoto(input: {
  checklistId: string
  reason?: string
}): Promise<RemovePhotoState> {
  const admin = await requireAdmin()

  const [row] = await db
    .select({
      id: endOfUseChecklists.id,
      storageKey: endOfUseChecklists.photoStorageKey,
      deletedAt: endOfUseChecklists.photoDeletedAt,
    })
    .from(endOfUseChecklists)
    .where(eq(endOfUseChecklists.id, input.checklistId))
    .limit(1)

  if (!row?.storageKey) return { error: 'That photo is not here any more.' }
  if (row.deletedAt) return { success: 'That photo was already removed.' }

  // Storage first. If it fails, nothing is written — a row marked deleted while the file is still
  // sitting in the bucket is the one outcome worse than not deleting at all, because the page
  // would then say the photograph is gone when it is not.
  const removed = await deleteEquipmentPhoto(row.storageKey)
  if (!removed.ok) return { error: removed.detail }

  const reason = input.reason?.trim()
  await db
    .update(endOfUseChecklists)
    .set({
      photoDeletedAt: new Date(),
      photoDeletedBy: admin.id,
      photoDeletedReason: reason && reason.length > 0 ? reason.slice(0, 300) : null,
    })
    .where(eq(endOfUseChecklists.id, input.checklistId))

  revalidatePath('/app/admin/equipment')
  revalidatePath('/app/appointments')

  return { success: 'Photo removed. The record that it was taken stays.' }
}
