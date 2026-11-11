'use server'

import { revalidatePath } from 'next/cache'

import { getCurrentUser } from '@/lib/auth/dal'
import { contractUploadPath, recordContract } from '@/lib/rooms/contracts'

// The two server halves of uploading a signed contract. The file itself goes from the browser
// straight to the store in between — see `contract-upload.tsx`.
//
// Used by the tenant on this page and by Keoni on Rooms, which is why neither is behind
// `requireProvider` or `requireAdmin`: who may act for whom is decided per contract, in
// `mayHandleContractFor`.

export async function contractUploadPathAction(
  providerId: string,
  mimeType: string,
): Promise<{ pathname: string } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Sign in again, then retry.' }
  return contractUploadPath(user, providerId, mimeType)
}

export async function recordContractAction(
  pathname: string,
): Promise<{ ok: true } | { error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: 'Sign in again, then retry.' }
  const result = await recordContract(user, pathname)
  revalidatePath('/app/room-rental')
  revalidatePath('/app/admin/rooms')
  return result
}
