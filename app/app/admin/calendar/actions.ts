'use server'

import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { denverInstant } from '@/lib/db/queries/availability'
import { blockTime, unblockTime } from '@/lib/db/queries/blocked-time'

// Taking laser time out of service, and putting it back.
//
// The calendar page had no server action at all before this — it was read-only, and closing an
// hour meant a developer writing SQL. These two are the whole of the write surface.

export interface BlockState {
  error?: string
  success?: string
}

/**
 * Closes a window so nobody can book it.
 *
 * Times arrive as the clock on the wall and are converted with `denverInstant`, the same helper
 * the availability grid uses — DST-correct in a way that assembling a UTC offset by hand is not,
 * which matters because the two days a year it is wrong are exactly the days somebody is least
 * likely to check.
 */
export async function blockLaserTime(
  _prev: BlockState,
  formData: FormData,
): Promise<BlockState> {
  const admin = await requireAdmin()

  const date = String(formData.get('date') ?? '')
  const time = String(formData.get('time') ?? '')
  const minutes = Number(formData.get('minutes') ?? 0)
  const reason = String(formData.get('reason') ?? '')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date.' }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Pick a start time.' }
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 12 * 60) {
    return { error: 'How long? Between 1 minute and 12 hours.' }
  }

  const start = denverInstant(date, time)
  const end = new Date(start.getTime() + minutes * 60_000)

  // Blocking time that has already passed does nothing — nobody can book the past anyway — and
  // it would sit in the list looking like it was doing something.
  if (end <= new Date()) return { error: 'That window has already passed.' }

  const result = await blockTime({ start, end, reason, createdBy: admin.id })
  if ('error' in result) return { error: result.error }

  // The grid a provider is looking at, as well as this page.
  revalidatePath('/app/admin/calendar')
  revalidatePath('/app/book')

  return { success: 'Blocked. Nobody can book that time.' }
}

/** Reopens a window. */
export async function unblockLaserTime(id: string): Promise<BlockState> {
  await requireAdmin()

  const { removed } = await unblockTime(id)

  revalidatePath('/app/admin/calendar')
  revalidatePath('/app/book')

  return removed
    ? { success: 'Reopened. That time can be booked again.' }
    : { error: 'That block has already gone.' }
}
