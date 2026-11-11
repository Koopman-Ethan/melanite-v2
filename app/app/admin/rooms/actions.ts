'use server'

import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/dal'
import { denverToday } from '@/lib/db/queries/admin-calendar'
import { toCents } from '@/lib/money'
import { decideDeposit, endLeaseNow, recordNotice, renewLease, startLease } from '@/lib/rooms/lease'
import type { LeaseResult } from '@/lib/rooms/lease'

// Keoni's lease actions. Every Stripe charge a lease makes starts here or in a webhook — a
// tenant's own clicks never move money.

function refresh() {
  revalidatePath('/app/admin/rooms')
  revalidatePath('/app/room-rental')
}

export async function startLeaseAction(input: {
  providerId: string
  roomId: string
  startsOn: string
  deposit: string
  depositHeldOutside: boolean
}): Promise<LeaseResult> {
  const admin = await requireAdmin()

  // As text, through `toCents`'s decimal parse — never through a float.
  const deposit = input.deposit.trim().replace(/^\$/, '') || '0'
  if (!/^\d+(\.\d{1,2})?$/.test(deposit)) return { error: 'Enter the deposit as a dollar amount.' }

  const result = await startLease({
    adminId: admin.id,
    providerId: input.providerId,
    roomId: input.roomId,
    startsOn: input.startsOn,
    today: denverToday(),
    depositCents: toCents(deposit),
    depositHeldOutside: input.depositHeldOutside,
  })
  refresh()
  return result
}

export async function recordNoticeAction(leaseId: string, noticeOn: string): Promise<LeaseResult> {
  await requireAdmin()
  const result = await recordNotice(leaseId, noticeOn)
  refresh()
  return result
}

export async function renewLeaseAction(leaseId: string): Promise<LeaseResult> {
  await requireAdmin()
  const result = await renewLease(leaseId)
  refresh()
  return result
}

export async function endLeaseNowAction(leaseId: string): Promise<LeaseResult> {
  await requireAdmin()
  const result = await endLeaseNow(leaseId, denverToday())
  refresh()
  return result
}

export async function decideDepositAction(
  leaseId: string,
  decision: 'refund' | 'keep',
): Promise<LeaseResult> {
  await requireAdmin()
  if (decision !== 'refund' && decision !== 'keep') return { error: 'Choose refund or keep.' }
  const result = await decideDeposit(leaseId, decision)
  refresh()
  return result
}
