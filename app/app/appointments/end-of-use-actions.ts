'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { requireProvider } from '@/lib/auth/dal'
import { db } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import { bookings, endOfUseChecklists } from '@/lib/db/schema'
import { deleteEquipmentPhoto, putEquipmentPhoto } from '@/lib/blob'
import {
  END_OF_USE_ITEM_COUNT,
  END_OF_USE_VERSION,
  DEVICE_ISSUE_NOTE_MAX,
  REQUIRED_ITEM_COUNT,
  closeoutWindowOpen,
  deviceIssueError,
  missingRequired,
  sanitiseItems,
} from '@/lib/end-of-use'
import { notifyCloseout } from '@/lib/notify-melanite'

// Signing off a session.
//
// Records what was DONE to the room, and — when something is wrong with the machine — one
// photograph of it. Those used to be two features: a before/after bracket around every session,
// and a checklist beside it. Keoni dropped the brackets on 2026-09-17, so this is now the only
// path by which a picture of the laser ever reaches Melanite.
//
// Nothing retroactive, ever. Past the twelve-hour window it is refused, because other people have
// used the room by then and a record nobody can trust is worth less than no record.

export interface ChecklistState {
  error?: string
  success?: string
}

/** The document's own free-text field, and the general note beside it. Capped together because
 *  neither is a place for a case note. */
const NOTE_MAX = 500

export async function recordEndOfUseChecklist(
  _prev: ChecklistState,
  formData: FormData,
): Promise<ChecklistState> {
  const user = await requireProvider()

  const bookingId = String(formData.get('bookingId') ?? '')
  const deviceIssueAnswer = String(formData.get('deviceIssue') ?? '')
  const deviceIssueNote = String(formData.get('deviceIssueNote') ?? '')
  const note = String(formData.get('note') ?? '').trim() || null
  const photo = formData.get('photo')

  // No default and no "unanswered". This is the answer with a consequence, and a form that lets
  // it go by unticked would quietly record "no issues" for every session somebody rushed.
  if (deviceIssueAnswer !== 'none' && deviceIssueAnswer !== 'reported') {
    return { error: 'Say whether there was a problem with the device.' }
  }
  const deviceIssue = deviceIssueAnswer === 'reported'

  const issueError = deviceIssueError(deviceIssue, deviceIssueNote)
  if (issueError) return { error: issueError }

  // A report carries a picture. This replaced the before/after brackets entirely, so it is the
  // only photograph of the machine anything will ever have — a description with nothing to look at
  // is now the whole of the record rather than a gap beside one.
  if (deviceIssue && !(photo instanceof File)) {
    return { error: 'Add a photo of what is wrong.' }
  }

  if (note && note.length > NOTE_MAX) {
    return { error: `Keep the note under ${NOTE_MAX} characters.` }
  }

  // Ownership is part of the query, not a check afterwards — the same shape every other action
  // here uses. A close-out written against somebody else's booking is an attribution to a person
  // who was not in the room.
  const [booking] = await db
    .select({ id: bookings.id, status: bookings.status, startTime: bookings.startTime, endTime: bookings.endTime })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.providerId, user.id)))
    .limit(1)

  if (!booking) return { error: 'That appointment is not yours.' }

  if (booking.status === 'cancelled' || booking.status === 'no_show') {
    return { error: 'That appointment did not happen, so there is nothing to close out.' }
  }

  if (booking.endTime > new Date()) {
    return { error: 'That session has not finished yet.' }
  }

  // Twelve hours. Past that, other people have used the room, and a check-off filed now would
  // describe a state this provider did not leave it in — worse than the gap it fills.
  if (!closeoutWindowOpen(booking)) {
    return {
      error: 'That session is closed. A check-off now would describe a room others have used since.',
    }
  }

  const items = sanitiseItems(formData.getAll('items').map(String))

  // The rule, enforced here and not by the disabled button. v1 had no check at all on this side,
  // so a close-out with nothing ticked was accepted and certified — which is exactly what happened
  // the first time somebody used it. The form disables its own button too; that is a courtesy to
  // whoever is standing in the room, and it is not what makes this true.
  const missing = missingRequired(items)
  if (missing.length > 0) {
    const named = missing.slice(0, 2).map((i) => i.label.toLowerCase()).join('; ')
    const rest = missing.length > 2 ? `, and ${missing.length - 2} more` : ''
    return {
      error: `Still to tick (${missing.length} of ${REQUIRED_ITEM_COUNT} required): ${named}${rest}.`,
    }
  }

  // Storage first, database second. The constraint says a reported fault has a `photo_storage_key`
  // — writing the row first and uploading after would leave a row asserting a photograph that may
  // not have made it, which is the one direction that cannot be recovered from. An orphaned blob
  // is the harmless failure and is cleaned up below.
  let stored: { storageKey: string; mimeType: string; sizeBytes: number } | null = null
  if (deviceIssue && photo instanceof File) {
    const result = await putEquipmentPhoto(crypto.randomUUID(), photo)
    if (!result.ok) return { error: result.detail }
    stored = result.blob
  }

  let checklistId: string
  try {
    const [inserted] = await db
      .insert(endOfUseChecklists)
      .values({
        bookingId: booking.id,
        providerId: user.id,
        version: END_OF_USE_VERSION,
        completedItems: items,
        itemCount: END_OF_USE_ITEM_COUNT,
        deviceIssue,
        deviceIssueNote: deviceIssue
          ? deviceIssueNote.trim().slice(0, DEVICE_ISSUE_NOTE_MAX)
          : null,
        note,
        photoStorageKey: stored?.storageKey ?? null,
        photoMimeType: stored?.mimeType ?? null,
        photoSizeBytes: stored?.sizeBytes ?? null,
      })
      .returning({ id: endOfUseChecklists.id })
    checklistId = inserted.id
  } catch (err) {
    // The row never landed, so nothing points at the image. Delete it rather than leave a blob
    // nobody can reach.
    if (stored) await deleteEquipmentPhoto(stored.storageKey)

    // One row per booking, enforced by a unique index. Somebody submitting twice — a double tap,
    // a stale tab — gets told, not a stack trace. The row already there is theirs and stands.
    if (isUniqueViolation(err)) {
      return { error: 'That session was already closed out.' }
    }
    throw err
  }

  revalidatePath('/app/appointments')
  revalidatePath('/app/dashboard')

  // ONLY when somebody actually wrote something. Keoni asked to hear about every close-out, then
  // saw what that meant in her inbox and asked on 2026-09-17 for the quiet ones to stop — a mail
  // per session saying nothing happened is a mail she learns to delete unread, and the one
  // reporting a chipped handpiece goes with it.
  //
  // The test is the two free-text boxes, not the tick count. A fault description and a note are
  // the only things a provider writes in their own words, and they are the only parts nobody can
  // reconstruct from the admin page. The conditional items are deliberately NOT a trigger on
  // their own: ticking "supply shortage" and typing nothing leaves her a notification she cannot
  // act on, and the form already asks for the detail in the notes box.
  //
  // Everything still lands on /app/admin/equipment and in the evening digest either way — this
  // decides what is worth interrupting her for, not what is recorded.
  const worthSending = deviceIssue || note !== null
  if (worthSending) await notifyCloseout(checklistId)

  // Everything required is ticked or we would not be here, so there is no shortfall to report
  // back. The count says which of the conditional five also applied, which is information rather
  // than a shortcoming.
  return {
    success:
      items.length >= END_OF_USE_ITEM_COUNT
        ? 'Closed out. That is your record of how you left it.'
        : `Closed out — all ${REQUIRED_ITEM_COUNT} required${
            items.length > REQUIRED_ITEM_COUNT
              ? `, plus ${items.length - REQUIRED_ITEM_COUNT} more`
              : ''
          }.`,
  }
}
